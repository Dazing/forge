# agent-images/Dockerfile
#
# Combined agent/runtime image: the locked .NET Playwright base plus a
# checksum-verified Node 22 LTS archive. Every input is digest- or
# checksum-pinned to the values in agent-images/images.lock — no floating
# tag, no mutable package input. The build script (scripts/build-image)
# verifies the lock before building and passes the locked values as build
# args so this file never resolves a tag on its own.
#
# Must preserve:
#   * the final image contains no registry credentials and no Docker
#     socket / client configuration.
#   * only the verified Node archive and the utilities it needs are added.

# --pin-by-digest: the reference_or_url digest of the playwright_dotnet_base
# lock entry (manifest-list digest; docker buildx resolves the per-platform
# leaf from --platform). Never a tag.
FROM mcr.microsoft.com/playwright/dotnet@sha256:25e558a847d4ae1ff7d14fa263de7fa2fffd357c1e50471278e522cec5ac1bb5

# Locked values are the defaults; build-image re-supplies them from the lock
# via --build-arg so a lock change can never drift out of sync silently.
ARG NODE_SHA256=fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8
ARG NODE_URL=https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-arm64.tar.xz
ARG BASE_DIGEST=sha256:25e558a847d4ae1ff7d14fa263de7fa2fffd357c1e50471278e522cec5ac1bb5
ARG SOURCE_REVISION=

ENV NODE_INSTALL=/opt/node

# Install the verified Node archive. The MCR Playwright .NET base already
# ships curl and ca-certificates, so no floating apt package input is added
# (AC1). The archive is rejected unless its SHA-256 matches the locked value
# exactly.
RUN set -eux; \
    command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; \
    if command -v curl >/dev/null; then \
      curl -fsSL "$NODE_URL" -o /tmp/node.tar.xz; \
    else \
      wget -qO /tmp/node.tar.xz "$NODE_URL"; \
    fi; \
    echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -; \
    mkdir -p "$NODE_INSTALL"; \
    tar -xJf /tmp/node.tar.xz -C "$NODE_INSTALL" --strip-components=1; \
    ln -sf "$NODE_INSTALL/bin/node" /usr/local/bin/node; \
    ln -sf "$NODE_INSTALL/bin/npm"  /usr/local/bin/npm; \
    ln -sf "$NODE_INSTALL/bin/npx"  /usr/local/bin/npx; \
    rm -f /tmp/node.tar.xz; \
    hash -r

# Record input provenance. The tag never ships as an approved value; these
# labels are the only provenance that lands in the image.
LABEL org.opencontainers.image.revision="$SOURCE_REVISION" \
      org.opencontainers.image.base.digest="$BASE_DIGEST" \
      org.opencontainers.image.node.sha256="$NODE_SHA256" \
      org.opencontainers.image.title="agent-dotnet-playwright-node" \
      org.opencontainers.image.vendor="software-factory"

# Final-layer smoke: the required executables and the Playwright browser
# directory must all be present, or the build fails here.
RUN set -eux; \
    command -v dotnet >/dev/null; dotnet --version; \
    command -v node   >/dev/null; node --version; \
    command -v npm    >/dev/null; npm --version; \
    test -n "${PLAYWRIGHT_BROWSERS_PATH}" ; \
    test -d "${PLAYWRIGHT_BROWSERS_PATH}" ; \
    # Prove the image carries no registry credentials or docker socket client
    # config — this must hold for the approved image.
    test ! -e /root/.docker/config.json; \
    test -z "${DOCKER_HOST:-}"; \
    echo "agent runtime verified: dotnet $(dotnet --version) node $(node --version) npm $(npm --version) browsers=${PLAYWRIGHT_BROWSERS_PATH}"

CMD ["/bin/bash"]
