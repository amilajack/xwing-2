// Upstream's server declaration omits the implemented datagram writable stream.
import "@fails-components/webtransport";
declare module "@fails-components/webtransport/dist/lib/dom" {
  interface WebTransportDatagramDuplexStream {
    writable: WritableStream<Uint8Array>;
  }
}
