FROM node:24-bookworm-slim AS node_runtime
FROM ubuntu:24.04 AS artifact
COPY --from=node_runtime /usr/local/ /usr/local/
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl libstdc++6 && rm -rf /var/lib/apt/lists/*
WORKDIR /out
RUN npm init -y && npm install --omit=dev @fails-components/webtransport@1.6.11 @fails-components/webtransport-transport-http3-quiche@1.6.11 @prisma/client@6.19.3 prisma@6.19.3 three@0.185.1
RUN node --input-type=module -e 'const native = await import("@fails-components/webtransport-transport-http3-quiche"); if (typeof native.Http3WebTransportServer !== "function" || process.arch !== "arm64") throw Error("ARM64 QUIC runtime unavailable"); console.log("ARM64 native QUIC import passed")'
COPY prisma /out/prisma
RUN npx prisma generate
COPY dist /out/dist
COPY ops /out/ops
RUN mkdir -p /out/bin && cp /usr/local/bin/node /out/bin/node && tar czf /release.tar.gz -C /out .
FROM scratch
COPY --from=artifact /release.tar.gz /
