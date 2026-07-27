# npm and Bun candidate layout

`@smorinlabs/skillsmith` is the launcher package and owns the public `skillsmith` bin. Its four
exact-version optional dependencies are:

- `@smorinlabs/skillsmith-darwin-arm64`
- `@smorinlabs/skillsmith-darwin-x64`
- `@smorinlabs/skillsmith-linux-arm64`
- `@smorinlabs/skillsmith-linux-x64`

Each payload contains only package metadata, README, license, and `bin/skillsmith`. Standard
`os`/`cpu` metadata, plus `libc: glibc` on Linux, selects the host payload. The launcher works with
Node when installed by npm and with Bun when Node is absent. There is no install hook, downloader,
workspace dependency, or public JavaScript API.

These packages are built and clean-installed locally in G6-01. They are not yet published; G6-04
must verify scope authority and trusted publishing before changing that statement.
