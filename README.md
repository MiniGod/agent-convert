# agent-convert

Convert sessions between **Claude Code** and **GitHub Copilot CLI**.

## Install

```bash
bun install -g agent-convert
```

## Usage

```bash
# Convert a Copilot CLI session to Claude Code
agent-convert copilot-to-claude <copilot-session-id>

# Convert a Claude Code session to Copilot CLI
agent-convert claude-to-copilot <claude-session-id>
```

Session IDs can be partial — the converter will match the first session that starts with the given prefix.

## Requirements

- [Bun](https://bun.sh) runtime (uses `bun:sqlite` for reading Copilot session databases)
