interface InviteModeSwitchProps {
  isLoginMode: boolean;
  onSwitch: (toLoginMode: boolean) => void;
}

/** The link under the invite form that toggles between registering and signing in. */
export function InviteModeSwitch({ isLoginMode, onSwitch }: InviteModeSwitchProps) {
  return (
    <p className="text-muted-foreground text-sm">
      {isLoginMode ? (
        <>
          Don't have an account?{' '}
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => onSwitch(false)}
            data-testid="invite-switch-register"
          >
            Register
          </button>
        </>
      ) : (
        <>
          Already have an account?{' '}
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => onSwitch(true)}
            data-testid="invite-switch-login"
          >
            Sign in
          </button>
        </>
      )}
    </p>
  );
}
