FROM node:22-bookworm-slim AS node-runtime
FROM oven/bun:1.3.14 AS bun-runtime

FROM mcr.microsoft.com/dotnet/sdk:10.0-noble

COPY --from=node-runtime /usr/local/ /usr/local/
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update \
    && apt-get install --yes --no-install-recommends bash ca-certificates curl git jq openssh-client python3 \
    && rm -rf /var/lib/apt/lists/*

# Sandcastle's Docker provider defaults these to the host user's IDs when building.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN set -eux; \
    if ! getent group "${AGENT_GID}" >/dev/null; then groupadd --gid "${AGENT_GID}" agent; fi; \
    if ! getent passwd "${AGENT_UID}" >/dev/null; then \
      useradd --uid "${AGENT_UID}" --gid "${AGENT_GID}" --create-home --shell /bin/bash agent; \
    fi; \
    mkdir -p /home/agent/.pi/agent/skills /home/agent/.omp/agent/skills /home/agent/.factory-assets /home/agent/.factory-handoff/result /home/agent/workspace; \
    chown -R "${AGENT_UID}:${AGENT_GID}" /home/agent

ENV DOTNET_CLI_HOME=/home/agent \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    NUGET_XMLDOC_MODE=skip \
    HOME=/home/agent \
    PATH=/home/agent/.local/bin:$PATH

USER root
RUN DOTNET_CLI_HOME=/tmp/dotnet dotnet tool install --tool-path /usr/local/bin RoslynMcp --version 1.2.3 \
    && rm -rf /tmp/dotnet \
    && npm install --global --ignore-scripts @earendil-works/pi-coding-agent@1.1.0 \
    && npm install --global --ignore-scripts @oh-my-pi/pi-coding-agent@18.8.4 \
    && npm install --prefix /home/agent/.factory-assets --ignore-scripts --omit=dev @modelcontextprotocol/sdk@1.32.1 ajv@8.20.0 \
    && printf '%s\n' \
      '{' \
      '  "mcpServers": {' \
      '    "roslyn": {' \
      '      "command": "roslynmcp",' \
      '      "exposure": "direct",' \
      '      "description": "Use Roslyn semantic analysis for C# navigation, diagnostics, refactoring, builds, and tests."' \
      '    },' \
      '    "microsoft-learn": {' \
      '      "url": "https://learn.microsoft.com/api/mcp",' \
      '      "exposure": "direct",' \
      '      "description": "Search and fetch current official Microsoft documentation and code samples."' \
      '    },' \
      '    "handoff": {' \
      '      "command": "node",' \
      '      "args": ["/home/agent/.factory-assets/handoff-server.mjs"],' \
      '      "env": {"FACTORY_HANDOFF_CONTROL_DIR": "/home/agent/.factory-handoff"},' \
      '      "exposure": "direct",' \
      '      "description": "Submit the authoritative typed result for the current factory stage."' \
      '    }' \
      '  }' \
      '}' \
      > /home/agent/.pi/agent/mcp.json \
    && printf '%s\n' \
      '{"mcpServers":{"roslyn":{"command":"roslynmcp"},"microsoft-learn":{"type":"http","url":"https://learn.microsoft.com/api/mcp"},"handoff":{"command":"node","args":["/home/agent/.factory-assets/handoff-server.mjs"],"env":{"FACTORY_HANDOFF_CONTROL_DIR":"/home/agent/.factory-handoff"}}}}' \
      > /home/agent/.omp/agent/mcp.json \
    && chown -R "${AGENT_UID}:${AGENT_GID}" /home/agent
USER ${AGENT_UID}:${AGENT_GID}

WORKDIR /home/agent
ENTRYPOINT ["sleep", "infinity"]
