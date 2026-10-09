FROM node:22-bookworm-slim AS node-runtime

FROM mcr.microsoft.com/dotnet/sdk:10.0.401-noble AS roslyn-mcp-build

ARG ROSLYN_MCP_COMMIT=2b93a0decd09e77203ee38b4f2a37595ac739cd4
RUN git init /src/roslyn-mcp \
    && git -C /src/roslyn-mcp remote add origin https://github.com/VuDZ/RoslynMcpServer.git \
    && git -C /src/roslyn-mcp fetch --depth 1 origin "${ROSLYN_MCP_COMMIT}" \
    && git -C /src/roslyn-mcp checkout --detach FETCH_HEAD \
    && dotnet publish /src/roslyn-mcp/RoslynMcpServer.csproj \
        --configuration Release \
        --no-self-contained \
        -p:PublishReadyToRun=false \
        --output /out

FROM mcr.microsoft.com/dotnet/sdk:10.0.401-noble

COPY --from=node-runtime /usr/local/ /usr/local/
COPY --from=roslyn-mcp-build /out/ /opt/roslyn-mcp/

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git jq openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global opencode-ai@1.18.35 \
    && npm cache clean --force

ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN set -eux; \
    if ! getent group "${AGENT_GID}" >/dev/null; then \
        groupadd --gid "${AGENT_GID}" agent; \
    fi; \
    if ! getent passwd "${AGENT_UID}" >/dev/null; then \
        useradd --uid "${AGENT_UID}" --gid "${AGENT_GID}" --create-home --shell /bin/bash agent; \
    fi; \
    mkdir -p /home/agent/.cache /home/agent/.config/opencode /home/agent/.local/share /home/agent/workspace /opt/roslyn-mcp/logs; \
    chown -R "${AGENT_UID}:${AGENT_GID}" /home/agent /opt/roslyn-mcp/logs

COPY --chown=${AGENT_UID}:${AGENT_GID} containers/agent/opencode.json /home/agent/.config/opencode/opencode.json

ENV DOTNET_CLI_HOME=/home/agent \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    NUGET_XMLDOC_MODE=skip \
    HOME=/home/agent

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent
ENTRYPOINT ["sleep", "infinity"]
