use std::sync::{Arc, Mutex};

use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::core::credential::{
    CredentialError, CredentialProvider, CredentialProviderSafety, CredentialProviderStatus,
};

const KEYRING_SERVICE: &str = "com.funny.remote-connector.ssh-password";
const PROVIDER_HEALTH_TARGET: &str = "_provider-health-check";
const RECORD_MAGIC: &[u8; 4] = b"FRC1";
const RECORD_HEADER_BYTES: usize = RECORD_MAGIC.len() + 4 + 1;
const RECORD_ACTIVE: u8 = 1;
const RECORD_TOMBSTONE: u8 = 0;
const MAX_PASSWORD_BYTES: usize = 4_096;

trait SecretStore: Send + Sync {
    fn persistence_is_safe(&self) -> bool;
    fn read(&self, target_id: &str) -> Result<Option<Zeroizing<Vec<u8>>>, ()>;
    fn write(&self, target_id: &str, value: &[u8]) -> Result<(), ()>;
}

#[cfg(any(target_os = "macos", windows))]
#[derive(Debug, Default)]
struct KeyringSecretStore;

#[cfg(any(target_os = "macos", windows))]
impl KeyringSecretStore {
    fn entry(target_id: &str) -> Result<keyring::Entry, ()> {
        keyring::Entry::new(KEYRING_SERVICE, target_id).map_err(|_| ())
    }

    fn without_prompt<T>(operation: impl FnOnce() -> Result<T, ()>) -> Result<T, ()> {
        #[cfg(target_os = "macos")]
        let _interaction_lock =
            security_framework::os::macos::keychain::SecKeychain::user_interaction_allowed()
                .map_err(|_| ())?
                .then(|| {
                    security_framework::os::macos::keychain::SecKeychain::disable_user_interaction()
                        .map_err(|_| ())
                })
                .transpose()?;
        operation()
    }
}

#[cfg(any(target_os = "macos", windows))]
impl SecretStore for KeyringSecretStore {
    fn persistence_is_safe(&self) -> bool {
        matches!(
            keyring::default::default_credential_builder().persistence(),
            keyring::credential::CredentialPersistence::UntilDelete
        )
    }

    fn read(&self, target_id: &str) -> Result<Option<Zeroizing<Vec<u8>>>, ()> {
        Self::without_prompt(|| {
            let entry = Self::entry(target_id)?;
            match entry.get_secret() {
                Ok(value) => Ok(Some(Zeroizing::new(value))),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(()),
            }
        })
    }

    fn write(&self, target_id: &str, value: &[u8]) -> Result<(), ()> {
        Self::without_prompt(|| Self::entry(target_id)?.set_secret(value).map_err(|_| ()))
    }
}

#[cfg(target_os = "linux")]
#[derive(Debug, Default)]
struct SecretServiceStore;

#[cfg(target_os = "linux")]
impl SecretServiceStore {
    fn connect() -> Result<dbus_secret_service::SecretService, ()> {
        dbus_secret_service::SecretService::connect_with_max_prompt_timeout(
            dbus_secret_service::EncryptionType::Dh,
            0,
        )
        .map_err(|_| ())
    }

    fn attributes(target_id: &str) -> std::collections::HashMap<&str, &str> {
        std::collections::HashMap::from([
            ("target", "default"),
            ("service", KEYRING_SERVICE),
            ("username", target_id),
        ])
    }
}

#[cfg(target_os = "linux")]
impl SecretStore for SecretServiceStore {
    fn persistence_is_safe(&self) -> bool {
        true
    }

    fn read(&self, target_id: &str) -> Result<Option<Zeroizing<Vec<u8>>>, ()> {
        let service = Self::connect()?;
        let collection = service.get_default_collection().map_err(|_| ())?;
        if collection.is_locked().map_err(|_| ())? {
            return Err(());
        }
        let search = service
            .search_items(Self::attributes(target_id))
            .map_err(|_| ())?;
        if !search.locked.is_empty() || search.unlocked.len() > 1 {
            return Err(());
        }
        search
            .unlocked
            .first()
            .map(|item| item.get_secret().map(Zeroizing::new).map_err(|_| ()))
            .transpose()
    }

    fn write(&self, target_id: &str, value: &[u8]) -> Result<(), ()> {
        let service = Self::connect()?;
        let search = service
            .search_items(Self::attributes(target_id))
            .map_err(|_| ())?;
        if !search.locked.is_empty() || search.unlocked.len() > 1 {
            return Err(());
        }
        if let Some(item) = search.unlocked.first() {
            return item
                .set_secret(value, "application/octet-stream")
                .map_err(|_| ());
        }

        let collection = service.get_default_collection().map_err(|_| ())?;
        if collection.is_locked().map_err(|_| ())? {
            return Err(());
        }
        let mut attributes = Self::attributes(target_id);
        attributes.insert("application", "funny-remote-connector");
        collection
            .create_item(
                &format!("Funny Remote Connector credential {target_id}"),
                attributes,
                value,
                true,
                "application/octet-stream",
            )
            .map(|_| ())
            .map_err(|_| ())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
#[derive(Debug, Default)]
struct UnsupportedSecretStore;

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
impl SecretStore for UnsupportedSecretStore {
    fn persistence_is_safe(&self) -> bool {
        false
    }

    fn read(&self, _target_id: &str) -> Result<Option<Zeroizing<Vec<u8>>>, ()> {
        Err(())
    }

    fn write(&self, _target_id: &str, _value: &[u8]) -> Result<(), ()> {
        Err(())
    }
}

pub struct NativeCredentialProvider {
    store: Option<Arc<dyn SecretStore>>,
    operation_lock: Mutex<()>,
}

impl std::fmt::Debug for NativeCredentialProvider {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeCredentialProvider")
            .field("status", &self.status())
            .finish_non_exhaustive()
    }
}

impl NativeCredentialProvider {
    pub fn discover() -> Self {
        #[cfg(any(target_os = "macos", windows))]
        let store: Arc<dyn SecretStore> = Arc::new(KeyringSecretStore);
        #[cfg(target_os = "linux")]
        let store: Arc<dyn SecretStore> = Arc::new(SecretServiceStore);
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        let store: Arc<dyn SecretStore> = Arc::new(UnsupportedSecretStore);

        Self::from_store(store)
    }

    fn from_store(store: Arc<dyn SecretStore>) -> Self {
        let store = (store.persistence_is_safe() && store.read(PROVIDER_HEALTH_TARGET).is_ok())
            .then_some(store);
        Self {
            store,
            operation_lock: Mutex::new(()),
        }
    }

    fn secret_store(&self) -> Result<&dyn SecretStore, CredentialError> {
        self.store
            .as_deref()
            .ok_or(CredentialError::ProviderUnavailable)
    }

    fn read_record(&self, target_id: &str) -> Result<Option<CredentialRecord>, CredentialError> {
        self.secret_store()?
            .read(target_id)
            .map_err(|()| CredentialError::ProviderUnavailable)?
            .map(|bytes| CredentialRecord::decode(&bytes))
            .transpose()
    }

    fn write_record(
        &self,
        target_id: &str,
        record: &CredentialRecord,
    ) -> Result<(), CredentialError> {
        let encoded = record.encode();
        self.secret_store()?
            .write(target_id, &encoded)
            .map_err(|()| CredentialError::ProviderUnavailable)
    }

    fn lock_operations(&self) -> Result<std::sync::MutexGuard<'_, ()>, CredentialError> {
        self.operation_lock
            .lock()
            .map_err(|_| CredentialError::ProviderUnavailable)
    }
}

impl CredentialProvider for NativeCredentialProvider {
    fn status(&self) -> CredentialProviderStatus {
        if self.store.is_some() {
            CredentialProviderStatus::Available
        } else {
            CredentialProviderStatus::Unavailable
        }
    }

    fn safety(&self) -> CredentialProviderSafety {
        CredentialProviderSafety::NoLeak
    }

    fn resolve(
        &self,
        target_id: &str,
        credential_version: u32,
    ) -> Result<Zeroizing<String>, CredentialError> {
        let _guard = self.lock_operations()?;
        let record = self
            .read_record(target_id)?
            .filter(|record| record.version == credential_version && record.password.is_some())
            .ok_or(CredentialError::ProviderUnavailable)?;
        record.password.ok_or(CredentialError::ProviderUnavailable)
    }

    fn store(
        &self,
        target_id: &str,
        credential_version: u32,
        password: &str,
    ) -> Result<(), CredentialError> {
        if password.is_empty() || password.len() > MAX_PASSWORD_BYTES {
            return Err(CredentialError::EnrolmentRejected);
        }
        let _guard = self.lock_operations()?;
        if let Some(current) = self.read_record(target_id)? {
            if credential_version < current.version {
                return Err(CredentialError::EnrolmentRejected);
            }
            if credential_version == current.version {
                return match current.password {
                    Some(existing) if existing.as_bytes().ct_eq(password.as_bytes()).into() => {
                        Ok(())
                    }
                    _ => Err(CredentialError::EnrolmentRejected),
                };
            }
        }
        self.write_record(
            target_id,
            &CredentialRecord {
                version: credential_version,
                password: Some(Zeroizing::new(password.to_owned())),
            },
        )
    }

    fn delete(&self, target_id: &str, credential_version: u32) -> Result<(), CredentialError> {
        let _guard = self.lock_operations()?;
        if let Some(current) = self.read_record(target_id)? {
            if credential_version < current.version {
                return Err(CredentialError::EnrolmentRejected);
            }
            if credential_version == current.version && current.password.is_none() {
                return Ok(());
            }
        }
        self.write_record(
            target_id,
            &CredentialRecord {
                version: credential_version,
                password: None,
            },
        )
    }
}

struct CredentialRecord {
    version: u32,
    password: Option<Zeroizing<String>>,
}

impl CredentialRecord {
    fn encode(&self) -> Zeroizing<Vec<u8>> {
        let password_length = self.password.as_ref().map_or(0, |password| password.len());
        let mut bytes = Zeroizing::new(Vec::with_capacity(RECORD_HEADER_BYTES + password_length));
        bytes.extend_from_slice(RECORD_MAGIC);
        bytes.extend_from_slice(&self.version.to_be_bytes());
        bytes.push(if self.password.is_some() {
            RECORD_ACTIVE
        } else {
            RECORD_TOMBSTONE
        });
        if let Some(password) = &self.password {
            bytes.extend_from_slice(password.as_bytes());
        }
        bytes
    }

    fn decode(bytes: &[u8]) -> Result<Self, CredentialError> {
        if bytes.len() < RECORD_HEADER_BYTES || &bytes[..RECORD_MAGIC.len()] != RECORD_MAGIC {
            return Err(CredentialError::ProviderUnavailable);
        }
        let version = u32::from_be_bytes(
            bytes[RECORD_MAGIC.len()..RECORD_MAGIC.len() + 4]
                .try_into()
                .map_err(|_| CredentialError::ProviderUnavailable)?,
        );
        if version == 0 {
            return Err(CredentialError::ProviderUnavailable);
        }
        let state = bytes[RECORD_MAGIC.len() + 4];
        let password_bytes = &bytes[RECORD_HEADER_BYTES..];
        let password = match state {
            RECORD_ACTIVE
                if !password_bytes.is_empty() && password_bytes.len() <= MAX_PASSWORD_BYTES =>
            {
                Some(Zeroizing::new(
                    String::from_utf8(password_bytes.to_vec())
                        .map_err(|_| CredentialError::ProviderUnavailable)?,
                ))
            }
            RECORD_TOMBSTONE if password_bytes.is_empty() => None,
            _ => return Err(CredentialError::ProviderUnavailable),
        };
        Ok(Self { version, password })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[derive(Default)]
    struct TestSecretStore {
        persistent: bool,
        entries: Mutex<BTreeMap<String, Zeroizing<Vec<u8>>>>,
    }

    impl TestSecretStore {
        fn persistent() -> Self {
            Self {
                persistent: true,
                entries: Mutex::new(BTreeMap::new()),
            }
        }
    }

    impl SecretStore for TestSecretStore {
        fn persistence_is_safe(&self) -> bool {
            self.persistent
        }

        fn read(&self, target_id: &str) -> Result<Option<Zeroizing<Vec<u8>>>, ()> {
            Ok(self
                .entries
                .lock()
                .map_err(|_| ())?
                .get(target_id)
                .map(|value| Zeroizing::new(value.to_vec())))
        }

        fn write(&self, target_id: &str, value: &[u8]) -> Result<(), ()> {
            self.entries
                .lock()
                .map_err(|_| ())?
                .insert(target_id.to_owned(), Zeroizing::new(value.to_vec()));
            Ok(())
        }
    }

    fn provider() -> NativeCredentialProvider {
        NativeCredentialProvider::from_store(Arc::new(TestSecretStore::persistent()))
    }

    #[test]
    fn stores_resolves_rotates_and_tombstones_credentials() {
        let provider = provider();
        provider.store("target-1", 1, "first").expect("store");
        assert_eq!(
            provider.resolve("target-1", 1).expect("resolve").as_str(),
            "first"
        );

        provider.store("target-1", 2, "second").expect("rotate");
        assert!(matches!(
            provider.resolve("target-1", 1),
            Err(CredentialError::ProviderUnavailable)
        ));
        assert_eq!(
            provider.resolve("target-1", 2).expect("resolve").as_str(),
            "second"
        );

        provider.delete("target-1", 3).expect("delete");
        assert!(matches!(
            provider.resolve("target-1", 3),
            Err(CredentialError::ProviderUnavailable)
        ));
        assert!(matches!(
            provider.store("target-1", 2, "obsolete"),
            Err(CredentialError::EnrolmentRejected)
        ));
    }

    #[test]
    fn accepts_only_idempotent_retries_at_the_current_version() {
        let provider = provider();
        provider.store("target-1", 7, "secret").expect("store");
        provider
            .store("target-1", 7, "secret")
            .expect("idempotent retry");
        assert!(matches!(
            provider.store("target-1", 7, "different"),
            Err(CredentialError::EnrolmentRejected)
        ));

        provider.delete("target-1", 8).expect("delete");
        provider.delete("target-1", 8).expect("idempotent delete");
        assert!(matches!(
            provider.store("target-1", 8, "resurrection"),
            Err(CredentialError::EnrolmentRejected)
        ));
    }

    #[test]
    fn disables_non_persistent_stores() {
        let provider = NativeCredentialProvider::from_store(Arc::new(TestSecretStore::default()));
        assert_eq!(provider.status(), CredentialProviderStatus::Unavailable);
        assert!(matches!(
            provider.store("target-1", 1, "secret"),
            Err(CredentialError::ProviderUnavailable)
        ));
    }

    #[test]
    fn rejects_malformed_store_records_without_exposing_them() {
        let store = Arc::new(TestSecretStore::persistent());
        store
            .write("target-1", b"not-a-connector-record")
            .expect("seed malformed record");
        let provider = NativeCredentialProvider::from_store(store);
        assert!(matches!(
            provider.resolve("target-1", 1),
            Err(CredentialError::ProviderUnavailable)
        ));
    }
}
