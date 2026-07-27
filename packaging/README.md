# Distribution candidates

`bun run build:release` creates one ignored local candidate tree. It compiles each selected native
target once, then fans those exact bytes out to direct archives, the Homebrew formula candidate,
and platform-specific npm packages. It also writes `release-manifest.json` and `SHA256SUMS`.

The public identities are `@smorinlabs/skillsmith` for npm/Bun and
`smorinlabs/tap/skillsmith` for Homebrew. They are candidate identities only: G6-01 validates local
artifacts but does not publish, upload, modify the tap, or change shell startup files. Public
availability remains gated by P17-G6-04.

Direct archives contain the executable, `LICENSE`, and byte-stable Bash, zsh, and Fish completion
files. The npm launcher chooses one exact optional native payload without an install script or
network downloader. See [npm/README.md](npm/README.md) for the package layout.
