FROM node:22-bookworm-slim AS node-runtime

FROM mcr.microsoft.com/dotnet/sdk:10.0.100-bookworm-slim

COPY --from=node-runtime /usr/local/ /usr/local/

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git jq openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global opencode-ai@1.18.35 \
    && npm cache clean --force

ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupadd --gid "${AGENT_GID}" agent \
    && useradd --uid "${AGENT_UID}" --gid "${AGENT_GID}" --create-home --shell /bin/bash agent \
    && mkdir -p /home/agent/.cache /home/agent/.config /home/agent/.local/share /home/agent/workspace \
    && chown -R "${AGENT_UID}:${AGENT_GID}" /home/agent

ENV DOTNET_CLI_HOME=/home/agent \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    NUGET_XMLDOC_MODE=skip \
    HOME=/home/agent

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent
ENTRYPOINT ["sleep", "infinity"]
