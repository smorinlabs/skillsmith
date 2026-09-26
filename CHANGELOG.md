# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Commits follow [Conventional Commits](https://www.conventionalcommits.org/).

## [1.0.0](https://github.com/smorinlabs/skillsmith/compare/v0.8.0...v1.0.0) (2026-09-26)


### Features

* add bounded garbage collection ([d6e8b4f](https://github.com/smorinlabs/skillsmith/commit/d6e8b4f4ed11e2c5cb69f96095a42a1f09b7b098))
* add read-only Muse adapter ([23e5768](https://github.com/smorinlabs/skillsmith/commit/23e5768907febc6885257e1efab1cec890d6d4e8))
* add read-only Muse adapter with CI coverage and docs ([a7281f6](https://github.com/smorinlabs/skillsmith/commit/a7281f6ffe654e4326c7a3f97ad0ec63d47d61c0))
* add retained artifact preimage codec ([c9033e2](https://github.com/smorinlabs/skillsmith/commit/c9033e2d120f3070b176af028d457a7bd37af333))
* add scope-aware undo lifecycle ([c34be66](https://github.com/smorinlabs/skillsmith/commit/c34be66b7e2008fbfa713e7024490cb4388925c6))
* authorize retained update artifact operations ([7f65c18](https://github.com/smorinlabs/skillsmith/commit/7f65c18fe9b12455cb60ec37210d8d3825d3d290))
* **cli:** add bounded dynamic completion ([3657662](https://github.com/smorinlabs/skillsmith/commit/3657662e4d3ce2ec29aa239e147fcf73a1765a76))
* **cli:** add skills.sh search discovery ([bc12079](https://github.com/smorinlabs/skillsmith/commit/bc12079735c1fe0ea204b8b7dc250f0a61c06bef))
* **cli:** add skills.sh search discovery ([cbf345e](https://github.com/smorinlabs/skillsmith/commit/cbf345ee09313049ba800610b291cb1209c88c18))
* **cli:** adopt standard goreleaser artifacts ([139c329](https://github.com/smorinlabs/skillsmith/commit/139c329debda84e69f5f4790c58c07168e2993b2))
* **cli:** complete G6-03 presentation ([4b860c2](https://github.com/smorinlabs/skillsmith/commit/4b860c23b3273c63444bf8e8697ac9c72cec8d04))
* **cli:** generate progressive command help ([76b2354](https://github.com/smorinlabs/skillsmith/commit/76b2354cc41b834fe029eff5901f73350215cbb2))
* **core:** add exclusive private state ports ([56dde95](https://github.com/smorinlabs/skillsmith/commit/56dde958520935e92cd3d5fef75e65d9e442f4e5))
* **core:** add GC inventory and reachability planning ([1d3b1e8](https://github.com/smorinlabs/skillsmith/commit/1d3b1e83642ddfeb9823d3280a1b069e76192974))
* **core:** add owner-bound GC recovery storage ([30a32ce](https://github.com/smorinlabs/skillsmith/commit/30a32ce7d01ae22fb1071f01f5bb4eebf4614f5e))
* **core:** add sync application and cli composition ([c33cc18](https://github.com/smorinlabs/skillsmith/commit/c33cc187072ffcb91aa5b370157abfa5cdecdc7a))
* **core:** add sync endpoint observation ([7d2a912](https://github.com/smorinlabs/skillsmith/commit/7d2a912f80fed4e8b0f1c40201e619635741409b))
* **core:** execute sync across artifacts and placements ([7482b5e](https://github.com/smorinlabs/skillsmith/commit/7482b5ec757e47ea483dc4bcdc4dbb9656c1d442))
* **core:** harden GC recovery convergence ([0a55ad6](https://github.com/smorinlabs/skillsmith/commit/0a55ad671f68510617fe6e42854dc5a4c405f7ae))
* **core:** project sync through durable placement execution ([450e88b](https://github.com/smorinlabs/skillsmith/commit/450e88b8953e03575da889dead8c191aa0e3ffc5))
* implement P17 declarative workflow ([c2f7b9f](https://github.com/smorinlabs/skillsmith/commit/c2f7b9f0ebe1aeeeb8dc443e3620a403e689217d))
* implement P17 G5-02 update lifecycle ([9da4675](https://github.com/smorinlabs/skillsmith/commit/9da467501e9015ec660e960b0d883d1a11bb640b))
* **main:** activate fail-closed git hooks ([c16a735](https://github.com/smorinlabs/skillsmith/commit/c16a73573c571893fdeb50c2c862048b6c98ae11))
* **main:** activate Muse user+custom lifecycle at capability v2 ([b7643ae](https://github.com/smorinlabs/skillsmith/commit/b7643ae0bda3fc2bec39c34385d4aceb58b7124e))
* **main:** add fail-closed git hook wrappers (dormant) ([1ca1764](https://github.com/smorinlabs/skillsmith/commit/1ca1764482aa122cc3f647abdee66feedb35c564))
* **main:** bind g6-04 publication receipts ([5176412](https://github.com/smorinlabs/skillsmith/commit/51764125ba5dce5ca39dcfc372b0ed8be7fe441d))
* **main:** fail-closed git hook wrappers ([b65c94c](https://github.com/smorinlabs/skillsmith/commit/b65c94c88e5f8d6098a7182e7f7c1060918469f1))
* **main:** implement p17 g6-04 publication gates ([9b0fcf4](https://github.com/smorinlabs/skillsmith/commit/9b0fcf4a223fd8a7a1b114d8b05dcd21566b31ad))
* **main:** muse full-lifecycle support in user and custom scopes ([51afbf2](https://github.com/smorinlabs/skillsmith/commit/51afbf21da6ff6de924671677a2766e8f1dc6c35))
* model retained update artifact history ([d93287b](https://github.com/smorinlabs/skillsmith/commit/d93287bc170185e35b5f548e4d82c32c3d52d8f4))
* persist update artifact history ([8465e03](https://github.com/smorinlabs/skillsmith/commit/8465e0320b69ba051e335133eacd44c3eaace313))
* report cross-tool skill-name reuse via cross-tool-names ([44173ce](https://github.com/smorinlabs/skillsmith/commit/44173ceb027c26865e63c187202d7ca3ffd1c527))
* report cross-tool skill-name reuse via cross-tool-names ([af6dfc5](https://github.com/smorinlabs/skillsmith/commit/af6dfc524b64328e312e7f2cf1dc252e4a5ab846))
* restore retained update artifacts on undo ([86fd011](https://github.com/smorinlabs/skillsmith/commit/86fd0111e00335d15e46e1ef6d90569abbd4eae8))
* select repository skills by directory or frontmatter name ([4d3ea50](https://github.com/smorinlabs/skillsmith/commit/4d3ea50815812df9b6b8f11a44a6b39ce8c12f11))
* select repository skills by directory or frontmatter name ([676cbce](https://github.com/smorinlabs/skillsmith/commit/676cbcebdde32e0fe60127563d93059cde56c17f))


### Bug Fixes

* address Codex review findings on Muse support ([fd947a1](https://github.com/smorinlabs/skillsmith/commit/fd947a1b5d60a745e87f8749fc98161b8b4f42a6))
* batch immutable p17 receipt reads ([b41fd3d](https://github.com/smorinlabs/skillsmith/commit/b41fd3de183d94c80579610ddc6347cded001531))
* batch immutable p17 receipt reads ([00ff0d7](https://github.com/smorinlabs/skillsmith/commit/00ff0d7299c14f21ce095990ef1fccff75cedd40))
* canonicalize cross-tool-names fixture root for symlinked TMPDIR ([5307bbf](https://github.com/smorinlabs/skillsmith/commit/5307bbf5f7e33d2917069b0ce51a1f7c4b9c14a1))
* carry p19 closeout and fixture isolation into p17 ([2d79353](https://github.com/smorinlabs/skillsmith/commit/2d79353d40020590f44fa0d56e4735005897ca23))
* carry product bug closeout into p17 ([e960b2c](https://github.com/smorinlabs/skillsmith/commit/e960b2cfefe043d8f04d045fd7907870746738cb))
* **cli:** close adversarial help gaps ([057f72d](https://github.com/smorinlabs/skillsmith/commit/057f72d93452362c3333dc8aea8509e9c0a81dce))
* **cli:** close completion trust boundaries ([d8a6d64](https://github.com/smorinlabs/skillsmith/commit/d8a6d64393f27a4ba01a32f9a6933fda6a132de9))
* **cli:** close G6-03 presentation boundaries ([d8f12ee](https://github.com/smorinlabs/skillsmith/commit/d8f12ee010a8439d56b277a7a997d024f624b776))
* **cli:** close independent help review gaps ([dbe57bc](https://github.com/smorinlabs/skillsmith/commit/dbe57bc7b61c044b2c34f308f223949ba823eaa2))
* **cli:** normalize Commander invocation modes ([c18432b](https://github.com/smorinlabs/skillsmith/commit/c18432b807167271724c65ab0a6159ad5c13ceb5))
* **cli:** pin npm for release candidates ([1e4f184](https://github.com/smorinlabs/skillsmith/commit/1e4f184a81cc7d9547c5b48283658f95f94651f8))
* **cli:** resolve release tools portably ([bfade54](https://github.com/smorinlabs/skillsmith/commit/bfade54daacb017b356ad7f5d10ac1f3500f689a))
* **cli:** share human path quoting across renderers ([8f8b02a](https://github.com/smorinlabs/skillsmith/commit/8f8b02a4f56f7ed0442237bddeb33f82574e999a))
* **cli:** use current homebrew cask commands ([3b4f4a2](https://github.com/smorinlabs/skillsmith/commit/3b4f4a2da196eb3de49244fdc3f27e89375a3a5d))
* close P17 G5-03 terminal regressions ([c498126](https://github.com/smorinlabs/skillsmith/commit/c4981261919d518080b850d7535979d7c3fe947f))
* close product bugs and track deferred publication work ([837d41c](https://github.com/smorinlabs/skillsmith/commit/837d41cc79cb6d7c499d7ec87ddba2efe9d171d9))
* close release security refactor blockers ([a640e51](https://github.com/smorinlabs/skillsmith/commit/a640e51d59deebf2dc184c0b842f426347bd5034))
* close retained artifact recovery gaps ([e778e6b](https://github.com/smorinlabs/skillsmith/commit/e778e6bf12195eb4e909a91a2987c85ca80746e1))
* close review findings on cross-tool-names ledger order and goldens ([522ff7b](https://github.com/smorinlabs/skillsmith/commit/522ff7b3140346ab1fa891377345f1d99becd9ad))
* complete local loader fixtures and review corrections ([d0ea2f4](https://github.com/smorinlabs/skillsmith/commit/d0ea2f4fd2548836445f03c745bb9e543fd07152))
* **core:** accept observed claude missing-name diagnostics ([d4b3d71](https://github.com/smorinlabs/skillsmith/commit/d4b3d71eb8b3712a7296425fd7b4c46685fa18f4))
* **core:** accept observed Claude missing-name diagnostics ([78c51b4](https://github.com/smorinlabs/skillsmith/commit/78c51b439ada730ce4c5f74513cd840222fbdafe))
* **core:** aggregate sync destination skill groups ([f208534](https://github.com/smorinlabs/skillsmith/commit/f208534f88aad13f263f73e0041c07c7fc95d8cc))
* **core:** align sync wire and fixture contracts ([0555440](https://github.com/smorinlabs/skillsmith/commit/0555440bbc2a24ff3fccc762bbdf2e9a36800ee7))
* **core:** authorize first ledger bootstrap ([b79a3b2](https://github.com/smorinlabs/skillsmith/commit/b79a3b23ee0d06469692b779ebb8e9e72e3d62f3))
* **core:** bound codex cleanup and preserve artifact failures ([5adb299](https://github.com/smorinlabs/skillsmith/commit/5adb299b29c31011b12c9341ea5a789b16d6aba6))
* **core:** classify git-init kernel denial as permission-denied ([c514d26](https://github.com/smorinlabs/skillsmith/commit/c514d26852ab66e98e584a0a1168c30d02cb0c9f))
* **core:** classify git-init kernel denial as permission-denied ([3c30733](https://github.com/smorinlabs/skillsmith/commit/3c30733396fcfa0b44ffce58b6cefb347eaa6eab))
* **core:** close GC crash safety findings ([d4dc813](https://github.com/smorinlabs/skillsmith/commit/d4dc813c84e36ffd967cc5ba24092efe9c21fb1f))
* **core:** close GC recovery review findings ([388a9c0](https://github.com/smorinlabs/skillsmith/commit/388a9c03259cbf7e40de3da9d7be0cfb9346b1d2))
* **core:** close Phase 5 review findings ([5a4e5cd](https://github.com/smorinlabs/skillsmith/commit/5a4e5cd9f6db8a5131b25e323a19703c89a06e79))
* **core:** complete exact sync noop reruns ([1500a95](https://github.com/smorinlabs/skillsmith/commit/1500a95c47ba082da242dd1f3b96b6776f9b6e76))
* **core:** complete interrupted copy replacement via durable staged intent ([578be44](https://github.com/smorinlabs/skillsmith/commit/578be447e5aa696d9bf487ea27fde5b0e64fdd4b))
* **core:** complete interrupted copy replacement via durable staged intent ([fd515b3](https://github.com/smorinlabs/skillsmith/commit/fd515b3528b5b4b719e953b67c2116ca177ac5c9))
* **core:** converge GC staging and live roots ([fd01985](https://github.com/smorinlabs/skillsmith/commit/fd0198556cb547dab6102b3a4612b12b7fff8f4a))
* **core:** exclude top-level .git from root-skill store bytes ([5ef33c2](https://github.com/smorinlabs/skillsmith/commit/5ef33c27d94fdbe78dbc78c1055886dd2fa2f329))
* **core:** exclude top-level .git from root-skill store bytes ([237b876](https://github.com/smorinlabs/skillsmith/commit/237b876651ea8afaf947e9df638c9abee15c1721))
* **core:** gate git-init probe recursive cleanup on failure cause ([25e64b5](https://github.com/smorinlabs/skillsmith/commit/25e64b5deae975f51c415bde16f7f2ec4c8bc360))
* **core:** gate install-preview pinned match on proven content equality ([d72e7c1](https://github.com/smorinlabs/skillsmith/commit/d72e7c157b0a9e121c333d2acc19a036c35ccc2b))
* **core:** gate install-preview pinned match on proven content equality ([f7adc0d](https://github.com/smorinlabs/skillsmith/commit/f7adc0d02c9b06b84d5ff561b0fdd6f277cb2f6e))
* **core:** hide sync preparation projections ([0bd3eab](https://github.com/smorinlabs/skillsmith/commit/0bd3eab57a8182e77a4872d14eaba8be5d8b6943))
* **core:** isolate serial runner git fixtures ([8ebde4e](https://github.com/smorinlabs/skillsmith/commit/8ebde4edc3b7b560eb3dd881c1c23875230af64b))
* **core:** map normalized permission PortError to permission-denied at skills-root creation ([cc2e87f](https://github.com/smorinlabs/skillsmith/commit/cc2e87f842dc6b9f5ef8118e89a516eb9640477b))
* **core:** map normalized permission PortError to permission-denied at skills-root creation ([6ea9403](https://github.com/smorinlabs/skillsmith/commit/6ea9403341477abb767b18f2b242d015f1c5fbbb))
* **core:** match staged intent revision before continuing replacement ([714a566](https://github.com/smorinlabs/skillsmith/commit/714a56626f4b19d5266474d99932d97cdca89065))
* **core:** patch vulnerable parser and tooling dependencies ([b458413](https://github.com/smorinlabs/skillsmith/commit/b45841307c77204dd31aef17fba1968646969b3f)), closes [#65](https://github.com/smorinlabs/skillsmith/issues/65)
* **core:** preserve exact GC recovery outcomes ([53b039e](https://github.com/smorinlabs/skillsmith/commit/53b039ec177f0322e1f614eba2afb0f41d491f0f))
* **core:** preserve old symlink target for interrupted dev rollback ([8ae8560](https://github.com/smorinlabs/skillsmith/commit/8ae8560dc6b91bbd7cb2e8d29cbb196953118331))
* **core:** preserve old symlink target for interrupted dev rollback ([9273802](https://github.com/smorinlabs/skillsmith/commit/9273802c62abf1499b1ea1611f8c3a79070dfcef))
* **core:** preserve sync path identity ([62ae3d0](https://github.com/smorinlabs/skillsmith/commit/62ae3d0485059e62ae351ece42a67ed97a22112f))
* **core:** refuse cross-host install updates without force ([57fd4ea](https://github.com/smorinlabs/skillsmith/commit/57fd4ea97267a67b96d2e78958b9853220286b17))
* **core:** refuse cross-host install updates without force ([db865ce](https://github.com/smorinlabs/skillsmith/commit/db865ceda7c61e9b1c13027718b615f21d7ae923))
* **core:** reject private sync reports ([790edbe](https://github.com/smorinlabs/skillsmith/commit/790edbe2fadd650b8ab24bac0869e2e2d3a7ee2c))
* **core:** report truthful placement on install noop and emit no phantom op ([094a422](https://github.com/smorinlabs/skillsmith/commit/094a422f3d772ddf3b8a63c84c2289c77c2fa3cb))
* **core:** retain forced sync copy backups ([3f37bef](https://github.com/smorinlabs/skillsmith/commit/3f37bef20ba59f75aa9a189c09a6632d87e597f2))
* **core:** surface kept-backup path in preserved-copy replacement reason ([4029151](https://github.com/smorinlabs/skillsmith/commit/4029151cc026d3fa76ea2ddd57588d886d4e2299))
* **core:** surface kept-backup path in preserved-copy replacement reason ([ccb4c59](https://github.com/smorinlabs/skillsmith/commit/ccb4c594aad6d3b5c5fc93a5b7b3a80ab15a771e))
* correct verification, inventory and piped output bugs ([3dd85a0](https://github.com/smorinlabs/skillsmith/commit/3dd85a026a400d13b152600c7e1e2956542e94a7))
* discover malformed artifact journals structurally ([ec831af](https://github.com/smorinlabs/skillsmith/commit/ec831af33fe317bb5f9bc2727e611377f3a76f09))
* enforce credential scans across repository and history ([1b8d8b3](https://github.com/smorinlabs/skillsmith/commit/1b8d8b3781bc798bd1d6e470e6f93c99c3c6e95b))
* enforce scoped credential scanning ([0e7e875](https://github.com/smorinlabs/skillsmith/commit/0e7e875c3a738e8e9cf2d351825bc52908115afe))
* enforce test runner repository identity ([4acef35](https://github.com/smorinlabs/skillsmith/commit/4acef351b6fecd7e4367e012aaa65d0283951f90))
* enforce uninstall assertion and restore workflow lint ([5c84ae4](https://github.com/smorinlabs/skillsmith/commit/5c84ae48754f1743a2377bc4a7b83993c40d5431))
* extend list-v3 golden bounded-default tools with muse ([aa6f121](https://github.com/smorinlabs/skillsmith/commit/aa6f12192001b96cc14b70100a6eb10af8854598))
* finish codex shutdown and fixture isolation repairs ([b33c224](https://github.com/smorinlabs/skillsmith/commit/b33c2249a4a1709497020001540662e87b68995d))
* guard prepared undo publication ([0e89f87](https://github.com/smorinlabs/skillsmith/commit/0e89f8756e7d13a3ca3c16fbbdf48346bbda54fa))
* harden artifact lock recovery races ([b1825f2](https://github.com/smorinlabs/skillsmith/commit/b1825f280afb9807a5a03426bb99b897ff95a1ea))
* harden doctor fixtures and managed-entry checks ([be2297c](https://github.com/smorinlabs/skillsmith/commit/be2297cf78d0f6b40e647eeb6febca9b8ee41092))
* **main:** bind deletion provenance to repository ([bcbe2a8](https://github.com/smorinlabs/skillsmith/commit/bcbe2a8c2d40ff83356195b9260637bb38b6dd31))
* **main:** close serial test receipt gaps ([6f90949](https://github.com/smorinlabs/skillsmith/commit/6f9094901be45491d7a8a9bc16d78c3f41edeeba))
* **main:** fail closed on owned paths ([1ee9e6d](https://github.com/smorinlabs/skillsmith/commit/1ee9e6dc235ee15777335f386831897b55a5f196))
* **main:** make deletion record lookup merge-direction independent ([9e04506](https://github.com/smorinlabs/skillsmith/commit/9e045068e39daf4fe67b32181c59e7c542c638cc))
* **main:** patch newly disclosed advisories ([7f34c33](https://github.com/smorinlabs/skillsmith/commit/7f34c331e4da659c686cf9f2f03994e4af822043))
* **main:** remove hyphen-safe path guard from serial runner ([9bcfa08](https://github.com/smorinlabs/skillsmith/commit/9bcfa08ccd02b1e996dc8345e6edb22e4386202c))
* **main:** remove hyphen-safe path guard from serial runner ([ffe5851](https://github.com/smorinlabs/skillsmith/commit/ffe5851b64e078482a87e4c694d9ef1a13ec6b77))
* **main:** restore native release prerequisites ([6964b11](https://github.com/smorinlabs/skillsmith/commit/6964b111ccb7cb3aac6a4bd831cde757db8ed4be))
* **main:** scrub fixture git env, absolutize hook dir resolution ([23c7de4](https://github.com/smorinlabs/skillsmith/commit/23c7de42d12e1ce01064acb3cd3ab5f37bcfecf5))
* **main:** update terminal script characterization ([aada4b5](https://github.com/smorinlabs/skillsmith/commit/aada4b5a327be5f327c91bec78704f49a3412ef8))
* make artifact locks platform-private ([0e72960](https://github.com/smorinlabs/skillsmith/commit/0e729602559f858a4b32af9a5e8550c36f928217))
* normalize goreleaser inventory paths ([275a497](https://github.com/smorinlabs/skillsmith/commit/275a49732101796de510cc036abb2de2979e1263))
* preflight all artifact recovery actions ([65c3907](https://github.com/smorinlabs/skillsmith/commit/65c390702bedeb0ffa1db69adbf336f4c0130905))
* preflight update artifact recovery ([6eecc49](https://github.com/smorinlabs/skillsmith/commit/6eecc4993541c4ff8930742662824e5de0a1d69c))
* preserve doctor manifest digest domains ([e9d3312](https://github.com/smorinlabs/skillsmith/commit/e9d33128932c4e677cad74b945130b2e096f0a52))
* preserve edited uninstall backups ([63e425a](https://github.com/smorinlabs/skillsmith/commit/63e425a17d5ac414f7c436a1de28270ce69b2642))
* preserve G4B-03 digest and pair domains ([5fedbba](https://github.com/smorinlabs/skillsmith/commit/5fedbba305862f127c430081888356c4fcd46c49))
* preserve git index during p17 validation ([59ff941](https://github.com/smorinlabs/skillsmith/commit/59ff94112491eb913891956be8b8bec682a96eb6))
* preserve manifest digest domains ([959e0d0](https://github.com/smorinlabs/skillsmith/commit/959e0d0d05a212a932f321a4375586f11760b534))
* preserve undo cleanup authority ([7052528](https://github.com/smorinlabs/skillsmith/commit/7052528e3bfdddd8b65f7ce7c8a2502637b61f01))
* provision ordinary CI release-test tools ([6af151a](https://github.com/smorinlabs/skillsmith/commit/6af151ad25816edd0fe4086bf81e0f625249895b))
* quote the tree revision in agent reports ([903a5cb](https://github.com/smorinlabs/skillsmith/commit/903a5cbc96a4ccbd14bd5574ddaf84cac71f64cf))
* reject malformed wildcard input ([9afd564](https://github.com/smorinlabs/skillsmith/commit/9afd564e6fed3aefa10ce1adf2b14780dde09538))
* reject source URLs from Phase 5 reports ([223377b](https://github.com/smorinlabs/skillsmith/commit/223377b87578f325e72343af00741645535f1157))
* resolve verification and inventory review findings ([9ead9ec](https://github.com/smorinlabs/skillsmith/commit/9ead9eca4215aebabd2409d15834620c8a8fa233))
* revalidate retained artifacts before cleanup ([a311a53](https://github.com/smorinlabs/skillsmith/commit/a311a53a1543b08e3dde06ce1f1fd94c89a04fec))
* sanitize serial test child environment ([8fa8fbc](https://github.com/smorinlabs/skillsmith/commit/8fa8fbc32aa0b314f1bccdede56ad56b6768f435))
* scope artifact recovery identities ([42179d1](https://github.com/smorinlabs/skillsmith/commit/42179d1025c19d27283459e1cca9879982139bc2))
* validate current artifact authorities ([9193063](https://github.com/smorinlabs/skillsmith/commit/91930633c6c64cd53ff18932b823391d40c3bdb8))
* validate undo cleanup carriers ([b0f7ef7](https://github.com/smorinlabs/skillsmith/commit/b0f7ef7542342ca5f496c07cc9418c0c6352d950))


### Miscellaneous Chores

* **main:** instruct 1.0 major release for P17 graduation ([fc8aa78](https://github.com/smorinlabs/skillsmith/commit/fc8aa7841bb75f592095125a0d77f7e144321b7d))

## [0.8.0](https://github.com/smorinlabs/skillsmith/compare/v0.7.0...v0.8.0) (2026-09-07)


### Features

* add P17 remote connectivity test and resilient final gate ([#37](https://github.com/smorinlabs/skillsmith/issues/37)) ([091fc7d](https://github.com/smorinlabs/skillsmith/commit/091fc7d862d1e73f047630a4de9869a3d1a5c332))


### Bug Fixes

* **cli:** make package-scoped tests cwd-independent ([#28](https://github.com/smorinlabs/skillsmith/issues/28)) ([b2af417](https://github.com/smorinlabs/skillsmith/commit/b2af417b5b08ef6a318362b79cfeaeffe13cd58a)), closes [#19](https://github.com/smorinlabs/skillsmith/issues/19)
* **core:** make doctor scope checks read-only ([#27](https://github.com/smorinlabs/skillsmith/issues/27)) ([99fdadb](https://github.com/smorinlabs/skillsmith/commit/99fdadb456f20a4b63fe34323d433bff60f3eee1)), closes [#13](https://github.com/smorinlabs/skillsmith/issues/13)
* **core:** restore relative dev links from recorded path ([#26](https://github.com/smorinlabs/skillsmith/issues/26)) ([cc91520](https://github.com/smorinlabs/skillsmith/commit/cc91520c10155167c2770355d0acc4c14a51e162)), closes [#10](https://github.com/smorinlabs/skillsmith/issues/10)
* **core:** scrub repository state from production git ([#24](https://github.com/smorinlabs/skillsmith/issues/24)) ([1eb5501](https://github.com/smorinlabs/skillsmith/commit/1eb55017207900479b78fa3664c873a6100d8353)), closes [#20](https://github.com/smorinlabs/skillsmith/issues/20)
* recognize merged PRs in P17 final gate ([#32](https://github.com/smorinlabs/skillsmith/issues/32)) ([1f3446e](https://github.com/smorinlabs/skillsmith/commit/1f3446ecb10c1c4c1df08562b5325a34d2fa52b4))
* stage P17 sandbox setup and checks ([#36](https://github.com/smorinlabs/skillsmith/issues/36)) ([7810dd8](https://github.com/smorinlabs/skillsmith/commit/7810dd83ce24f7c1dbf3d51f62d1115e4a547d8f))

## [0.7.0](https://github.com/smorinlabs/skillsmith/compare/v0.6.0...v0.7.0) (2026-07-11)


### ⚠ BREAKING CHANGES

* **core:** dev --source that disagrees with an already-RECORDED dev source now REFUSES (S5b) instead of silently repointing the record. FlipAction and FlipReport['summary'] (public @skillsmith/core exports) gain created/adopted.

### Features

* **core:** dev --source creates and adopts dev placements ([#18](https://github.com/smorinlabs/skillsmith/issues/18)) ([e367f36](https://github.com/smorinlabs/skillsmith/commit/e367f36a686eddde66a57da678562b3d9623e3a7))


### Bug Fixes

* **core:** make --rollback --all selection direction-agnostic ([9b99500](https://github.com/smorinlabs/skillsmith/commit/9b99500e9792fcdbfff5a4e13945c0468b906fee)), closes [#11](https://github.com/smorinlabs/skillsmith/issues/11)

## [0.6.0](https://github.com/smorinlabs/skillsmith/compare/v0.5.0...v0.6.0) (2026-07-09)


### Features

* **cli:** add skillsmith install and uninstall acquisition commands ([#7](https://github.com/smorinlabs/skillsmith/issues/7)) ([2ba8d9e](https://github.com/smorinlabs/skillsmith/commit/2ba8d9e75e7e626fa738c088c289020000c1c823))

## [0.5.0](https://github.com/smorinlabs/skillsmith/compare/v0.4.0...v0.5.0) (2026-07-07)


### Features

* add promote and dev commands for bidirectional skill placement flips ([#5](https://github.com/smorinlabs/skillsmith/issues/5)) ([c74dbc4](https://github.com/smorinlabs/skillsmith/commit/c74dbc4d8e7450c9f9a583a1efba8569269e6ae2))

## [0.4.0](https://github.com/smorinlabs/skillsmith/compare/v0.3.2...v0.4.0) (2026-07-07)


### Features

* add skillsmith verify command for cross-tool skill/plugin load verification ([#3](https://github.com/smorinlabs/skillsmith/issues/3)) ([234e067](https://github.com/smorinlabs/skillsmith/commit/234e06744b5d37b4d49993ada9f935139c488f07))

## [0.3.2](https://github.com/smorinlabs/skillsmith/compare/v0.3.1...v0.3.2) (2026-07-06)


### Bug Fixes

* dependency security updates + P10 un-park hygiene ([#1](https://github.com/smorinlabs/skillsmith/issues/1)) ([3df05ba](https://github.com/smorinlabs/skillsmith/commit/3df05bacac9a6e0ae13cfcb6026e8a3e4ca0dee4))

## [Unreleased]

### Added
- Durable ledger-v2 mutation with visible, revision-checked v1 migration, crash recovery, immutable
  pair/project-registration updates, logical transaction history, and deterministic bounded-history
  cleanup. Existing v1 ledgers remain readable; current mutations never downgrade v2 state.
- `doctor --fix` and `doctor --dry-run` with a closed safe-repair allowlist, explicit approval,
  deterministic repair plans, strict refusal/cancellation behavior, and `health@2` output. The
  read-only `check` command remains byte-compatible on `health@1`.
- Persisted artifact contracts: a byte-oriented `ArtifactCodec` API and the single ordered `artifactContractRegistry` for `manifest@1`, `lock@1`, `plan@1`, `ledger@1`, `ledger@2`, and `journal@1`, distinct from the existing command-output `WireCodec` registry.
- Versioned persisted-artifact codec, DTO, and mapper exports on `@skillsmith/core/contracts/v1` and `@skillsmith/core/contracts/v2`, backed by the same codec objects as `artifactContractRegistry`.
- A read-only, capability-injected repository for manifest, lock, saved-plan, ledger, and journal artifacts. Legacy project configuration to manifest v1 and ledger v1 to v2 reads return descriptive migration metadata; the root API exposes no migration executor.
- Defensive artifact handling owns and validates untrusted values, refuses sensitive content with fixed safe errors, preserves declared compatibility framing, and prevents the legacy placement writer from downgrading ledger v2 or future versions.
- MVP-2b.1.1: plugin-bundled skill discovery — `skillsmith list --tool claude-code` now finds skills shipped by installed plugins in addition to standalone skills. Fixes a bug where a machine with 40+ active skills reported only 1.
- New top-level `skillsmith commands` subcommand lists slash commands discovered across `user` and `project` scopes.
- New `managed` scope (Claude Code policy-managed skills) with `CLAUDE_CODE_MANAGED_SETTINGS_PATH` override and `CLAUDE_CODE_DISABLE_POLICY_SKILLS` honored.
- Public API: `CommandEntry`, `Origin` (`standalone | plugin | policy`), `EnabledState` (`on | off | unset`), `PluginProvenanceScope` (`user | project | managed | local`).
- `list`/`commands` flags: `--enabled`, `--disabled`, `--unconfigured` filter by the new 3-state enablement; `list --managed` shorthand.
- ESLint zones for `plugins/**` and `commands/**` (type-only imports from sibling domains allowed via `except: ['./types.ts']`).
- JSON schema for `list` bumped to `schemaVersion: 2` with `origin` + `enabled` fields.
- Apache-2.0 license (`LICENSE`, `NOTICE`).
- Root `README.md`, `CONTRIBUTING.md`, and this `CHANGELOG.md`.
- Slim per-package READMEs (`packages/core/README.md`, `packages/cli/README.md`).
- `license: "Apache-2.0"` field on each `package.json`.
- ESLint with `import/no-restricted-paths` enforcing architectural zones (core ↔ cli, plus in-package CLI layering) via `eslint.config.js`. Wired into `bun run check` and into lefthook's pre-commit hook.
- ESLint `no-restricted-imports` + `no-restricted-syntax` rules scoped to `packages/core/src/**` (forbidding `commander`, `chalk`, `consola`, `@clack/prompts`, `node:console`, `process.exit`, and `console.{log,info,warn,error,debug}`) — replaces the earlier `scripts/check-core-boundary.ts`.
- New ESLint zones after core layering refactor: `env ↛ agents`, `env ↛ detect`, `detect ↛ agents`.
- `scripts/build-native.ts` to detect the host target; per-target `build:*` scripts so the default `build` is no longer hardcoded to `bun-darwin-arm64`.
- `bun-global` install-method classification for binaries under `~/.bun/install/global/**`.
- Tests: bun-global classification; markdown cell escaping.

### Changed
- Install, uninstall, dev, and promote now use the canonical ledger-v2 writer and preserve projects,
  registrations, pending transactions, committed history, and supported tool identifiers across
  every mutation.
- Core layering: `exec.ts` moved to `env/`; `InstallMethod`/`InstallRecord` split into `detect/types.ts`; orchestrator moved to `scan/`.
- `detectTool`/`detectAll` now forward an `AbortSignal` to each agent.
- `--color` flag goes through `resolveColorMode`, which sets `NO_COLOR`/`FORCE_COLOR`.
- Lefthook Biome and typecheck globs now use `**/` prefix.

### Fixed
- `exec.ts`: early-return on pre-aborted signal; read stdout concurrently with `proc.exited`.
- `renderAgentsMarkdown` escapes `|`, `\`, and newlines in cells.
- `defaultScanEnv` splits `PATH` using the platform `path.delimiter`.
- `help [topic]` emits an internal error and exits 1 if a known topic has no content.
- `SIGINT` handler sets `process.exitCode = 130` and exposes `wasInterrupted()`; `main()` returns 130 on interrupt.
- `fileExists` no longer falls back to `existsSync`; catches the failure and returns `false`.

### Removed
- `scripts/check-core-boundary.ts` (superseded by ESLint rules above).

## [0.3.1] — 2026-04-24

### Features

* **cli:** add --managed/--enabled/--disabled/--unconfigured to list, add commands subcommand ([a64921e](https://github.com/smorinlabs/skillsmith/commit/a64921e4eb7fbe806c62b48416d12f98ba8bb66b))
* **core:** add 'managed' to Scope enum ([c7f6a52](https://github.com/smorinlabs/skillsmith/commit/c7f6a52c46fe0125e48869c05328059bc8112979))
* **core:** add CommandEntry type parallel to SkillEntry ([f3e27da](https://github.com/smorinlabs/skillsmith/commit/f3e27dac85b60fcda07d4c31d7f8090c9ff8419d))
* **core:** add Origin tagged union + EnabledState + extend SkillEntry ([8c52a0d](https://github.com/smorinlabs/skillsmith/commit/8c52a0de8c25c14d47a384c238e39318b3b7c2cf))
* **core:** add plugins/ domain — installed.ts, enablement.ts, discover.ts ([fa85441](https://github.com/smorinlabs/skillsmith/commit/fa854417f2afdc4ab61404d5d222a6de5544a812))
* **core:** extend Agent interface with command-roots, plugin-paths, managed-path ([8d89fec](https://github.com/smorinlabs/skillsmith/commit/8d89fec50182ee279b75bea35e5bb97bb07b7734))
* **core:** listSkills extended for plugins+managed; add walkCommandDir + listCommands ([b4c4e92](https://github.com/smorinlabs/skillsmith/commit/b4c4e923155001b22d5ecbb6156c62af789a87b9))

## [0.3.0] — 2026-04-27

### ⚠ BREAKING CHANGES

* **cli:** installSigintHandler and SigintHandle are renamed to installSignalHandler and SignalHandle. These are @skillsmith/cli internals (no external callers), but documenting for completeness.

### Features

* **cli:** add list, doctor, and check commands ([3a2664b](https://github.com/smorinlabs/skillsmith/commit/3a2664b09f7644f6865872144adc5275e96f4caf))
* **core:** add 8 built-in doctor checks (xdg, config, tool, scope, dup, multi, legacy, network) ([904c9d0](https://github.com/smorinlabs/skillsmith/commit/904c9d048f57b0491e34732865adfb96496f3477))
* **core:** add doctor types, runChecks, and empty registry scaffold ([77ab8c6](https://github.com/smorinlabs/skillsmith/commit/77ab8c6f699fa47a45bd080b3b38eedb9f603e5f))
* **core:** add getSkillRoots for all four agents + Agent interface update ([0f87e90](https://github.com/smorinlabs/skillsmith/commit/0f87e90724c27ff94e7756bf9ad473210d45d329))
* **core:** add listSkills orchestrator with glob + dedup + duplicates ([51d9d75](https://github.com/smorinlabs/skillsmith/commit/51d9d7593701bf9eeb3c865ea861c35912c04bba))
* **core:** add ScanEnv.listDir and readText for filesystem enumeration ([4179358](https://github.com/smorinlabs/skillsmith/commit/4179358d983e8f3563369dfc2ec9c0a8decb9b41))
* **core:** add skill-parse-error variant + exit-code mapping ([a30510d](https://github.com/smorinlabs/skillsmith/commit/a30510dcc7d800963110a3f07347aaeda578385b))
* **core:** add SkillEntry types and parseSkillFrontmatter ([3297949](https://github.com/smorinlabs/skillsmith/commit/3297949461f85cbea3f6ad5831cdee3357274a2a))
* **core:** add walkSkillDir with fake-filesystem test matrix ([fd795cd](https://github.com/smorinlabs/skillsmith/commit/fd795cd8271628548fbc268f5e1c1058c2fa420f))
* **core:** export MVP-2b.1 public API + add scope-resolver to cli ([2dda7b2](https://github.com/smorinlabs/skillsmith/commit/2dda7b270dba9d6dae46c177f8e38df1f002058d))

### Bug Fixes

* align release automation with workspace version and pre-1.0 policy ([4510d4a](https://github.com/smorinlabs/skillsmith/commit/4510d4a13038802a2e4e9e1ca78d37f0ac15cfdc))
* **cli:** correct shell completion generation for bash, zsh, and fish ([efcec9f](https://github.com/smorinlabs/skillsmith/commit/efcec9f4fdb36cc14b7ad207180ec58ce30c3cf0))
* **cli:** handle SIGTERM in addition to SIGINT ([a515a61](https://github.com/smorinlabs/skillsmith/commit/a515a61270db974ef26c12e7a0a8d25d4d58a265))
* **cli:** validate config set values for tool and scope ([42feead](https://github.com/smorinlabs/skillsmith/commit/42feead7346dfb42509886c885b5c142f8e4aa73))
* **core:** validate SKILLSMITH_TOOL and SKILLSMITH_SCOPE against enums ([b428ace](https://github.com/smorinlabs/skillsmith/commit/b428acebc2a4d0d17f6e6a8c83661361b0fbdc5b))

## [0.2.0] — 2026-04-24

### Features

* **cli:** add commander-tree walker producing CompletionNode AST ([03154ba](https://github.com/smorinlabs/skillsmith/commit/03154ba5a6ad90b5f5c69d07b7fa50118b80398c))
* **cli:** render fish completion from CompletionNode tree ([3e82b2f](https://github.com/smorinlabs/skillsmith/commit/3e82b2fb406201ee9655d34ddb666a1df906657a))
* **cli:** wire completion command + exit-2 remap for commander usage errors ([c59c027](https://github.com/smorinlabs/skillsmith/commit/c59c02755de75ad5318baa6ded5621f4f6f11a64))
* **cli:** wire config get/set/list/unset into commander ([8eeedbd](https://github.com/smorinlabs/skillsmith/commit/8eeedbdc4cf2000b2ac9ecad358c6a98b401991b))
* **core:** add config path resolution (XDG + walk-up + explicit) ([1eafbd4](https://github.com/smorinlabs/skillsmith/commit/1eafbd465dc1a2a542ada58171be1573ebf312f9))
* **core:** add Config types, zod schema, config-error variant (exit 3) ([2123741](https://github.com/smorinlabs/skillsmith/commit/2123741bac1e13d9dfccae2c66ffaed032260baf))
* **core:** export loadConfig, saveConfig, and config types publicly ([c3e2c9b](https://github.com/smorinlabs/skillsmith/commit/c3e2c9b620cc3662f69021ce7d08e09b419f3217))
* **core:** layered loadConfig with per-key source tracking ([6bc8804](https://github.com/smorinlabs/skillsmith/commit/6bc88041c8b15a33a19d78be6cb051fe6f2ae14c))
* **core:** read partial Config from SKILLSMITH_* env vars ([4d2f55d](https://github.com/smorinlabs/skillsmith/commit/4d2f55d635d9703c4bf92fe0bdbcf1015bfe8b1f))
* **core:** saveConfig with proper-lockfile + atomic write-temp+rename ([f327239](https://github.com/smorinlabs/skillsmith/commit/f327239426bdc1ba9b9f751b47b3410ce9ff3796))
* **lint:** add ESLint import-boundary rules via import/no-restricted-paths ([cdc17b4](https://github.com/smorinlabs/skillsmith/commit/cdc17b46120cc5e32ce25a23877bb6f4dc581536))

### Bug Fixes

* **core:** wire AbortSignal through Agent.detect and runVersion (BUG-01, BUG-03) ([c68430c](https://github.com/smorinlabs/skillsmith/commit/c68430cdc36cf26a907c3589acdc4ac49972f1cc))
* **lint:** also block 'node:console' import in core (BUG-02) ([2247e78](https://github.com/smorinlabs/skillsmith/commit/2247e78f5c4825ef64c46e4c8ca588b77474c25f))
* round-1 bug audit — CLI, core, and tooling fixes ([544321d](https://github.com/smorinlabs/skillsmith/commit/544321d76aafd543e1ce885a87a53c9c6cec0ce5))

## [0.1.0] — 2026-04-24

Initial tagged release.

### Added
- Bun workspace scaffold, Biome lint/format config, TypeScript strict base.
- Lefthook pre-commit (biome, typecheck, actionlint), pre-push (tests), and commit-msg (conventional commits) hooks.
- CI workflow for macOS and Ubuntu.
- `@skillsmith/core`: `Result<T, SkillSmithError>` helpers, `SkillSmithError` tagged union, `Logger` interface + `noopLogger`, `ScanEnv` + `defaultScanEnv`, `runVersionCommand` with a 2-second abort timeout, agent types, and scanner utilities.
- Four supported agents: Claude Code, Codex, Kilo Code, opencode — each with detection, install hint, and stubs.
- Agent registry (`getAgent`, `listSupportedTools`), detection orchestrators (`detectAll`, `detectTool`), and public API surface.
- `skillsmith` CLI: commander entry, `agents` command, `version`, `help [topic]`, SIGINT handler, color-mode resolver honoring `NO_COLOR`/`FORCE_COLOR`/`TERM=dumb`, markdown + JSON (zod-validated) renderers, error-code → exit-code mapping.

[Unreleased]: https://github.com/smorinlabs/skillsmith/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/smorinlabs/skillsmith/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/smorinlabs/skillsmith/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/smorinlabs/skillsmith/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/smorinlabs/skillsmith/releases/tag/v0.1.0
