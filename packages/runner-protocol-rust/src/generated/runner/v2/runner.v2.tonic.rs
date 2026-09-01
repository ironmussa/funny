// @generated
/// Generated client implementations.
pub mod runner_transport_service_client {
    #![allow(
        unused_variables,
        dead_code,
        missing_docs,
        clippy::wildcard_imports,
        clippy::let_unit_value,
    )]
    use tonic::codegen::*;
    use tonic::codegen::http::Uri;
    #[derive(Debug, Clone)]
    pub struct RunnerTransportServiceClient<T> {
        inner: tonic::client::Grpc<T>,
    }
    impl RunnerTransportServiceClient<tonic::transport::Channel> {
        /// Attempt to create a new client by connecting to a given endpoint.
        pub async fn connect<D>(dst: D) -> Result<Self, tonic::transport::Error>
        where
            D: TryInto<tonic::transport::Endpoint>,
            D::Error: Into<StdError>,
        {
            let conn = tonic::transport::Endpoint::new(dst)?.connect().await?;
            Ok(Self::new(conn))
        }
    }
    impl<T> RunnerTransportServiceClient<T>
    where
        T: tonic::client::GrpcService<tonic::body::Body>,
        T::Error: Into<StdError>,
        T::ResponseBody: Body<Data = Bytes> + std::marker::Send + 'static,
        <T::ResponseBody as Body>::Error: Into<StdError> + std::marker::Send,
    {
        pub fn new(inner: T) -> Self {
            let inner = tonic::client::Grpc::new(inner);
            Self { inner }
        }
        pub fn with_origin(inner: T, origin: Uri) -> Self {
            let inner = tonic::client::Grpc::with_origin(inner, origin);
            Self { inner }
        }
        pub fn with_interceptor<F>(
            inner: T,
            interceptor: F,
        ) -> RunnerTransportServiceClient<InterceptedService<T, F>>
        where
            F: tonic::service::Interceptor,
            T::ResponseBody: Default,
            T: tonic::codegen::Service<
                http::Request<tonic::body::Body>,
                Response = http::Response<
                    <T as tonic::client::GrpcService<tonic::body::Body>>::ResponseBody,
                >,
            >,
            <T as tonic::codegen::Service<
                http::Request<tonic::body::Body>,
            >>::Error: Into<StdError> + std::marker::Send + std::marker::Sync,
        {
            RunnerTransportServiceClient::new(
                InterceptedService::new(inner, interceptor),
            )
        }
        /// Compress requests with the given encoding.
        ///
        /// This requires the server to support it otherwise it might respond with an
        /// error.
        #[must_use]
        pub fn send_compressed(mut self, encoding: CompressionEncoding) -> Self {
            self.inner = self.inner.send_compressed(encoding);
            self
        }
        /// Enable decompressing responses.
        #[must_use]
        pub fn accept_compressed(mut self, encoding: CompressionEncoding) -> Self {
            self.inner = self.inner.accept_compressed(encoding);
            self
        }
        /// Limits the maximum size of a decoded message.
        ///
        /// Default: `4MB`
        #[must_use]
        pub fn max_decoding_message_size(mut self, limit: usize) -> Self {
            self.inner = self.inner.max_decoding_message_size(limit);
            self
        }
        /// Limits the maximum size of an encoded message.
        ///
        /// Default: `usize::MAX`
        #[must_use]
        pub fn max_encoding_message_size(mut self, limit: usize) -> Self {
            self.inner = self.inner.max_encoding_message_size(limit);
            self
        }
        pub async fn control(
            &mut self,
            request: impl tonic::IntoStreamingRequest<Message = super::ControlRequest>,
        ) -> std::result::Result<
            tonic::Response<tonic::codec::Streaming<super::ControlResponse>>,
            tonic::Status,
        > {
            self.inner
                .ready()
                .await
                .map_err(|e| {
                    tonic::Status::unknown(
                        format!("Service was not ready: {}", e.into()),
                    )
                })?;
            let codec = tonic_prost::ProstCodec::default();
            let path = http::uri::PathAndQuery::from_static(
                "/runner.v2.RunnerTransportService/Control",
            );
            let mut req = request.into_streaming_request();
            req.extensions_mut()
                .insert(GrpcMethod::new("runner.v2.RunnerTransportService", "Control"));
            self.inner.streaming(req, path, codec).await
        }
        pub async fn operations(
            &mut self,
            request: impl tonic::IntoStreamingRequest<Message = super::OperationsRequest>,
        ) -> std::result::Result<
            tonic::Response<tonic::codec::Streaming<super::OperationsResponse>>,
            tonic::Status,
        > {
            self.inner
                .ready()
                .await
                .map_err(|e| {
                    tonic::Status::unknown(
                        format!("Service was not ready: {}", e.into()),
                    )
                })?;
            let codec = tonic_prost::ProstCodec::default();
            let path = http::uri::PathAndQuery::from_static(
                "/runner.v2.RunnerTransportService/Operations",
            );
            let mut req = request.into_streaming_request();
            req.extensions_mut()
                .insert(
                    GrpcMethod::new("runner.v2.RunnerTransportService", "Operations"),
                );
            self.inner.streaming(req, path, codec).await
        }
        pub async fn events(
            &mut self,
            request: impl tonic::IntoStreamingRequest<Message = super::EventsRequest>,
        ) -> std::result::Result<
            tonic::Response<tonic::codec::Streaming<super::EventsResponse>>,
            tonic::Status,
        > {
            self.inner
                .ready()
                .await
                .map_err(|e| {
                    tonic::Status::unknown(
                        format!("Service was not ready: {}", e.into()),
                    )
                })?;
            let codec = tonic_prost::ProstCodec::default();
            let path = http::uri::PathAndQuery::from_static(
                "/runner.v2.RunnerTransportService/Events",
            );
            let mut req = request.into_streaming_request();
            req.extensions_mut()
                .insert(GrpcMethod::new("runner.v2.RunnerTransportService", "Events"));
            self.inner.streaming(req, path, codec).await
        }
        pub async fn tunnel(
            &mut self,
            request: impl tonic::IntoStreamingRequest<Message = super::TunnelRequest>,
        ) -> std::result::Result<
            tonic::Response<tonic::codec::Streaming<super::TunnelResponse>>,
            tonic::Status,
        > {
            self.inner
                .ready()
                .await
                .map_err(|e| {
                    tonic::Status::unknown(
                        format!("Service was not ready: {}", e.into()),
                    )
                })?;
            let codec = tonic_prost::ProstCodec::default();
            let path = http::uri::PathAndQuery::from_static(
                "/runner.v2.RunnerTransportService/Tunnel",
            );
            let mut req = request.into_streaming_request();
            req.extensions_mut()
                .insert(GrpcMethod::new("runner.v2.RunnerTransportService", "Tunnel"));
            self.inner.streaming(req, path, codec).await
        }
        pub async fn terminal(
            &mut self,
            request: impl tonic::IntoStreamingRequest<Message = super::TerminalRequest>,
        ) -> std::result::Result<
            tonic::Response<tonic::codec::Streaming<super::TerminalResponse>>,
            tonic::Status,
        > {
            self.inner
                .ready()
                .await
                .map_err(|e| {
                    tonic::Status::unknown(
                        format!("Service was not ready: {}", e.into()),
                    )
                })?;
            let codec = tonic_prost::ProstCodec::default();
            let path = http::uri::PathAndQuery::from_static(
                "/runner.v2.RunnerTransportService/Terminal",
            );
            let mut req = request.into_streaming_request();
            req.extensions_mut()
                .insert(GrpcMethod::new("runner.v2.RunnerTransportService", "Terminal"));
            self.inner.streaming(req, path, codec).await
        }
    }
}
/// Generated server implementations.
pub mod runner_transport_service_server {
    #![allow(
        unused_variables,
        dead_code,
        missing_docs,
        clippy::wildcard_imports,
        clippy::let_unit_value,
    )]
    use tonic::codegen::*;
    /// Generated trait containing gRPC methods that should be implemented for use with RunnerTransportServiceServer.
    #[async_trait]
    pub trait RunnerTransportService: std::marker::Send + std::marker::Sync + 'static {
        /// Server streaming response type for the Control method.
        type ControlStream: tonic::codegen::tokio_stream::Stream<
                Item = std::result::Result<super::ControlResponse, tonic::Status>,
            >
            + std::marker::Send
            + 'static;
        async fn control(
            &self,
            request: tonic::Request<tonic::Streaming<super::ControlRequest>>,
        ) -> std::result::Result<tonic::Response<Self::ControlStream>, tonic::Status>;
        /// Server streaming response type for the Operations method.
        type OperationsStream: tonic::codegen::tokio_stream::Stream<
                Item = std::result::Result<super::OperationsResponse, tonic::Status>,
            >
            + std::marker::Send
            + 'static;
        async fn operations(
            &self,
            request: tonic::Request<tonic::Streaming<super::OperationsRequest>>,
        ) -> std::result::Result<tonic::Response<Self::OperationsStream>, tonic::Status>;
        /// Server streaming response type for the Events method.
        type EventsStream: tonic::codegen::tokio_stream::Stream<
                Item = std::result::Result<super::EventsResponse, tonic::Status>,
            >
            + std::marker::Send
            + 'static;
        async fn events(
            &self,
            request: tonic::Request<tonic::Streaming<super::EventsRequest>>,
        ) -> std::result::Result<tonic::Response<Self::EventsStream>, tonic::Status>;
        /// Server streaming response type for the Tunnel method.
        type TunnelStream: tonic::codegen::tokio_stream::Stream<
                Item = std::result::Result<super::TunnelResponse, tonic::Status>,
            >
            + std::marker::Send
            + 'static;
        async fn tunnel(
            &self,
            request: tonic::Request<tonic::Streaming<super::TunnelRequest>>,
        ) -> std::result::Result<tonic::Response<Self::TunnelStream>, tonic::Status>;
        /// Server streaming response type for the Terminal method.
        type TerminalStream: tonic::codegen::tokio_stream::Stream<
                Item = std::result::Result<super::TerminalResponse, tonic::Status>,
            >
            + std::marker::Send
            + 'static;
        async fn terminal(
            &self,
            request: tonic::Request<tonic::Streaming<super::TerminalRequest>>,
        ) -> std::result::Result<tonic::Response<Self::TerminalStream>, tonic::Status>;
    }
    #[derive(Debug)]
    pub struct RunnerTransportServiceServer<T> {
        inner: Arc<T>,
        accept_compression_encodings: EnabledCompressionEncodings,
        send_compression_encodings: EnabledCompressionEncodings,
        max_decoding_message_size: Option<usize>,
        max_encoding_message_size: Option<usize>,
    }
    impl<T> RunnerTransportServiceServer<T> {
        pub fn new(inner: T) -> Self {
            Self::from_arc(Arc::new(inner))
        }
        pub fn from_arc(inner: Arc<T>) -> Self {
            Self {
                inner,
                accept_compression_encodings: Default::default(),
                send_compression_encodings: Default::default(),
                max_decoding_message_size: None,
                max_encoding_message_size: None,
            }
        }
        pub fn with_interceptor<F>(
            inner: T,
            interceptor: F,
        ) -> InterceptedService<Self, F>
        where
            F: tonic::service::Interceptor,
        {
            InterceptedService::new(Self::new(inner), interceptor)
        }
        /// Enable decompressing requests with the given encoding.
        #[must_use]
        pub fn accept_compressed(mut self, encoding: CompressionEncoding) -> Self {
            self.accept_compression_encodings.enable(encoding);
            self
        }
        /// Compress responses with the given encoding, if the client supports it.
        #[must_use]
        pub fn send_compressed(mut self, encoding: CompressionEncoding) -> Self {
            self.send_compression_encodings.enable(encoding);
            self
        }
        /// Limits the maximum size of a decoded message.
        ///
        /// Default: `4MB`
        #[must_use]
        pub fn max_decoding_message_size(mut self, limit: usize) -> Self {
            self.max_decoding_message_size = Some(limit);
            self
        }
        /// Limits the maximum size of an encoded message.
        ///
        /// Default: `usize::MAX`
        #[must_use]
        pub fn max_encoding_message_size(mut self, limit: usize) -> Self {
            self.max_encoding_message_size = Some(limit);
            self
        }
    }
    impl<T, B> tonic::codegen::Service<http::Request<B>>
    for RunnerTransportServiceServer<T>
    where
        T: RunnerTransportService,
        B: Body + std::marker::Send + 'static,
        B::Error: Into<StdError> + std::marker::Send + 'static,
    {
        type Response = http::Response<tonic::body::Body>;
        type Error = std::convert::Infallible;
        type Future = BoxFuture<Self::Response, Self::Error>;
        fn poll_ready(
            &mut self,
            _cx: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
        fn call(&mut self, req: http::Request<B>) -> Self::Future {
            match req.uri().path() {
                "/runner.v2.RunnerTransportService/Control" => {
                    #[allow(non_camel_case_types)]
                    struct ControlSvc<T: RunnerTransportService>(pub Arc<T>);
                    impl<
                        T: RunnerTransportService,
                    > tonic::server::StreamingService<super::ControlRequest>
                    for ControlSvc<T> {
                        type Response = super::ControlResponse;
                        type ResponseStream = T::ControlStream;
                        type Future = BoxFuture<
                            tonic::Response<Self::ResponseStream>,
                            tonic::Status,
                        >;
                        fn call(
                            &mut self,
                            request: tonic::Request<
                                tonic::Streaming<super::ControlRequest>,
                            >,
                        ) -> Self::Future {
                            let inner = Arc::clone(&self.0);
                            let fut = async move {
                                <T as RunnerTransportService>::control(&inner, request)
                                    .await
                            };
                            Box::pin(fut)
                        }
                    }
                    let accept_compression_encodings = self.accept_compression_encodings;
                    let send_compression_encodings = self.send_compression_encodings;
                    let max_decoding_message_size = self.max_decoding_message_size;
                    let max_encoding_message_size = self.max_encoding_message_size;
                    let inner = self.inner.clone();
                    let fut = async move {
                        let method = ControlSvc(inner);
                        let codec = tonic_prost::ProstCodec::default();
                        let mut grpc = tonic::server::Grpc::new(codec)
                            .apply_compression_config(
                                accept_compression_encodings,
                                send_compression_encodings,
                            )
                            .apply_max_message_size_config(
                                max_decoding_message_size,
                                max_encoding_message_size,
                            );
                        let res = grpc.streaming(method, req).await;
                        Ok(res)
                    };
                    Box::pin(fut)
                }
                "/runner.v2.RunnerTransportService/Operations" => {
                    #[allow(non_camel_case_types)]
                    struct OperationsSvc<T: RunnerTransportService>(pub Arc<T>);
                    impl<
                        T: RunnerTransportService,
                    > tonic::server::StreamingService<super::OperationsRequest>
                    for OperationsSvc<T> {
                        type Response = super::OperationsResponse;
                        type ResponseStream = T::OperationsStream;
                        type Future = BoxFuture<
                            tonic::Response<Self::ResponseStream>,
                            tonic::Status,
                        >;
                        fn call(
                            &mut self,
                            request: tonic::Request<
                                tonic::Streaming<super::OperationsRequest>,
                            >,
                        ) -> Self::Future {
                            let inner = Arc::clone(&self.0);
                            let fut = async move {
                                <T as RunnerTransportService>::operations(&inner, request)
                                    .await
                            };
                            Box::pin(fut)
                        }
                    }
                    let accept_compression_encodings = self.accept_compression_encodings;
                    let send_compression_encodings = self.send_compression_encodings;
                    let max_decoding_message_size = self.max_decoding_message_size;
                    let max_encoding_message_size = self.max_encoding_message_size;
                    let inner = self.inner.clone();
                    let fut = async move {
                        let method = OperationsSvc(inner);
                        let codec = tonic_prost::ProstCodec::default();
                        let mut grpc = tonic::server::Grpc::new(codec)
                            .apply_compression_config(
                                accept_compression_encodings,
                                send_compression_encodings,
                            )
                            .apply_max_message_size_config(
                                max_decoding_message_size,
                                max_encoding_message_size,
                            );
                        let res = grpc.streaming(method, req).await;
                        Ok(res)
                    };
                    Box::pin(fut)
                }
                "/runner.v2.RunnerTransportService/Events" => {
                    #[allow(non_camel_case_types)]
                    struct EventsSvc<T: RunnerTransportService>(pub Arc<T>);
                    impl<
                        T: RunnerTransportService,
                    > tonic::server::StreamingService<super::EventsRequest>
                    for EventsSvc<T> {
                        type Response = super::EventsResponse;
                        type ResponseStream = T::EventsStream;
                        type Future = BoxFuture<
                            tonic::Response<Self::ResponseStream>,
                            tonic::Status,
                        >;
                        fn call(
                            &mut self,
                            request: tonic::Request<
                                tonic::Streaming<super::EventsRequest>,
                            >,
                        ) -> Self::Future {
                            let inner = Arc::clone(&self.0);
                            let fut = async move {
                                <T as RunnerTransportService>::events(&inner, request).await
                            };
                            Box::pin(fut)
                        }
                    }
                    let accept_compression_encodings = self.accept_compression_encodings;
                    let send_compression_encodings = self.send_compression_encodings;
                    let max_decoding_message_size = self.max_decoding_message_size;
                    let max_encoding_message_size = self.max_encoding_message_size;
                    let inner = self.inner.clone();
                    let fut = async move {
                        let method = EventsSvc(inner);
                        let codec = tonic_prost::ProstCodec::default();
                        let mut grpc = tonic::server::Grpc::new(codec)
                            .apply_compression_config(
                                accept_compression_encodings,
                                send_compression_encodings,
                            )
                            .apply_max_message_size_config(
                                max_decoding_message_size,
                                max_encoding_message_size,
                            );
                        let res = grpc.streaming(method, req).await;
                        Ok(res)
                    };
                    Box::pin(fut)
                }
                "/runner.v2.RunnerTransportService/Tunnel" => {
                    #[allow(non_camel_case_types)]
                    struct TunnelSvc<T: RunnerTransportService>(pub Arc<T>);
                    impl<
                        T: RunnerTransportService,
                    > tonic::server::StreamingService<super::TunnelRequest>
                    for TunnelSvc<T> {
                        type Response = super::TunnelResponse;
                        type ResponseStream = T::TunnelStream;
                        type Future = BoxFuture<
                            tonic::Response<Self::ResponseStream>,
                            tonic::Status,
                        >;
                        fn call(
                            &mut self,
                            request: tonic::Request<
                                tonic::Streaming<super::TunnelRequest>,
                            >,
                        ) -> Self::Future {
                            let inner = Arc::clone(&self.0);
                            let fut = async move {
                                <T as RunnerTransportService>::tunnel(&inner, request).await
                            };
                            Box::pin(fut)
                        }
                    }
                    let accept_compression_encodings = self.accept_compression_encodings;
                    let send_compression_encodings = self.send_compression_encodings;
                    let max_decoding_message_size = self.max_decoding_message_size;
                    let max_encoding_message_size = self.max_encoding_message_size;
                    let inner = self.inner.clone();
                    let fut = async move {
                        let method = TunnelSvc(inner);
                        let codec = tonic_prost::ProstCodec::default();
                        let mut grpc = tonic::server::Grpc::new(codec)
                            .apply_compression_config(
                                accept_compression_encodings,
                                send_compression_encodings,
                            )
                            .apply_max_message_size_config(
                                max_decoding_message_size,
                                max_encoding_message_size,
                            );
                        let res = grpc.streaming(method, req).await;
                        Ok(res)
                    };
                    Box::pin(fut)
                }
                "/runner.v2.RunnerTransportService/Terminal" => {
                    #[allow(non_camel_case_types)]
                    struct TerminalSvc<T: RunnerTransportService>(pub Arc<T>);
                    impl<
                        T: RunnerTransportService,
                    > tonic::server::StreamingService<super::TerminalRequest>
                    for TerminalSvc<T> {
                        type Response = super::TerminalResponse;
                        type ResponseStream = T::TerminalStream;
                        type Future = BoxFuture<
                            tonic::Response<Self::ResponseStream>,
                            tonic::Status,
                        >;
                        fn call(
                            &mut self,
                            request: tonic::Request<
                                tonic::Streaming<super::TerminalRequest>,
                            >,
                        ) -> Self::Future {
                            let inner = Arc::clone(&self.0);
                            let fut = async move {
                                <T as RunnerTransportService>::terminal(&inner, request)
                                    .await
                            };
                            Box::pin(fut)
                        }
                    }
                    let accept_compression_encodings = self.accept_compression_encodings;
                    let send_compression_encodings = self.send_compression_encodings;
                    let max_decoding_message_size = self.max_decoding_message_size;
                    let max_encoding_message_size = self.max_encoding_message_size;
                    let inner = self.inner.clone();
                    let fut = async move {
                        let method = TerminalSvc(inner);
                        let codec = tonic_prost::ProstCodec::default();
                        let mut grpc = tonic::server::Grpc::new(codec)
                            .apply_compression_config(
                                accept_compression_encodings,
                                send_compression_encodings,
                            )
                            .apply_max_message_size_config(
                                max_decoding_message_size,
                                max_encoding_message_size,
                            );
                        let res = grpc.streaming(method, req).await;
                        Ok(res)
                    };
                    Box::pin(fut)
                }
                _ => {
                    Box::pin(async move {
                        let mut response = http::Response::new(
                            tonic::body::Body::default(),
                        );
                        let headers = response.headers_mut();
                        headers
                            .insert(
                                tonic::Status::GRPC_STATUS,
                                (tonic::Code::Unimplemented as i32).into(),
                            );
                        headers
                            .insert(
                                http::header::CONTENT_TYPE,
                                tonic::metadata::GRPC_CONTENT_TYPE,
                            );
                        Ok(response)
                    })
                }
            }
        }
    }
    impl<T> Clone for RunnerTransportServiceServer<T> {
        fn clone(&self) -> Self {
            let inner = self.inner.clone();
            Self {
                inner,
                accept_compression_encodings: self.accept_compression_encodings,
                send_compression_encodings: self.send_compression_encodings,
                max_decoding_message_size: self.max_decoding_message_size,
                max_encoding_message_size: self.max_encoding_message_size,
            }
        }
    }
    /// Generated gRPC service name
    pub const SERVICE_NAME: &str = "runner.v2.RunnerTransportService";
    impl<T> tonic::server::NamedService for RunnerTransportServiceServer<T> {
        const NAME: &'static str = SERVICE_NAME;
    }
}
