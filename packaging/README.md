# Distribution candidates

`bun run build:release` creates one ignored local candidate tree. Pinned GoReleaser compiles each
of the four native targets once, then creates the direct archives, `SHA256SUMS`, standard internal
artifact inventory, and Homebrew cask candidate. A thin project adapter stages the same binary
bytes into the tracked npm package layouts and runs `npm pack --ignore-scripts`.

The public identities are `@smorinlabs/skillsmith` for npm/Bun and
`smorinlabs/tap/skillsmith` for Homebrew. They are candidate identities only: G6-01 validates local
artifacts but does not publish, upload, modify the tap, or change shell startup files. Public
availability remains gated by P17-G6-04.

Direct archives contain the executable, `LICENSE`, and byte-stable Bash, zsh, and Fish completion
files. The npm launcher chooses one exact optional native payload without an install script or
network downloader. See [npm/README.md](npm/README.md) for the package layout.

The candidate build is controlled and credential-free, but it is not claimed to be reproducible or
offline: a cold Bun cache can acquire the pinned cross-target runtimes. GoReleaser's
`artifacts.json` is internal build inventory, not a second public manifest.
