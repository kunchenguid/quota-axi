# Changelog

## [0.1.39](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.38...quota-axi-v0.1.39) (2026-09-07)


### Bug Fixes

* **providers:** probe stored-expired credentials instead of skipping them ([#150](https://github.com/kunchenguid/quota-axi/issues/150)) ([bf9e0a7](https://github.com/kunchenguid/quota-axi/commit/bf9e0a74be8e2382d28583d8e894d14e860e1b4f))

## [0.1.38](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.37...quota-axi-v0.1.38) (2026-09-05)


### Bug Fixes

* **providers:** fall back to working credential sources ([#147](https://github.com/kunchenguid/quota-axi/issues/147)) ([dc5accd](https://github.com/kunchenguid/quota-axi/commit/dc5accde5f8a8d6e2ec5ffa5ffdcd05a7d77e2c4))

## [0.1.37](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.36...quota-axi-v0.1.37) (2026-09-04)


### Bug Fixes

* **grok:** treat consumer-billing rejection as unmeasurable, not sign-out, for SuperGrok OAuth ([#142](https://github.com/kunchenguid/quota-axi/issues/142)) ([069379f](https://github.com/kunchenguid/quota-axi/commit/069379fcd5a80d8a6f39bffbbbfb8774f5d4a43f))

## [0.1.36](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.35...quota-axi-v0.1.36) (2026-09-03)


### Bug Fixes

* **agy:** discover Antigravity processes on Linux ([#141](https://github.com/kunchenguid/quota-axi/issues/141)) ([9797056](https://github.com/kunchenguid/quota-axi/commit/9797056378557a2c190beb204e875d05b4870b93))
* **claude:** preserve quota cache when Keychain access is denied ([#139](https://github.com/kunchenguid/quota-axi/issues/139)) ([de1d184](https://github.com/kunchenguid/quota-axi/commit/de1d18420365ffc57f208ab62f3269ce7a26aefc))

## [0.1.35](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.34...quota-axi-v0.1.35) (2026-09-01)


### Bug Fixes

* **providers:** honor configured HTTP proxies ([#136](https://github.com/kunchenguid/quota-axi/issues/136)) ([ef403f7](https://github.com/kunchenguid/quota-axi/commit/ef403f786665b8eabcbab207e976ae3cb9e120c8))
* **providers:** read Pi Codex OAuth credentials ([#132](https://github.com/kunchenguid/quota-axi/issues/132)) ([2b1b45e](https://github.com/kunchenguid/quota-axi/commit/2b1b45ecdb687a1770830cf10cd0c9573a6dbcfe))

## [0.1.34](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.33...quota-axi-v0.1.34) (2026-08-29)


### Features

* **providers:** add Alibaba and OpenCode Go quota reporting ([#124](https://github.com/kunchenguid/quota-axi/issues/124)) ([02cc64c](https://github.com/kunchenguid/quota-axi/commit/02cc64cfa4f00fe8248c30119c9a0d6c2fa77b52))


### Bug Fixes

* keep TUI viewport within terminal bounds ([#129](https://github.com/kunchenguid/quota-axi/issues/129)) ([14270a8](https://github.com/kunchenguid/quota-axi/commit/14270a8e502adf0e753ddfe7b59b1080fc251e5d))

## [0.1.33](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.32...quota-axi-v0.1.33) (2026-08-28)


### Bug Fixes

* prevent unsafe Claude credential refresh ([#128](https://github.com/kunchenguid/quota-axi/issues/128)) ([7fbe64c](https://github.com/kunchenguid/quota-axi/commit/7fbe64c2fdad35b6d4a3c952f7c78fc36282e7ac))
* **tui:** make the live report reachable in short terminals ([#125](https://github.com/kunchenguid/quota-axi/issues/125)) ([a539fb0](https://github.com/kunchenguid/quota-axi/commit/a539fb0b51b46bc4cb14a0a2abdc6677c87874f9))

## [0.1.32](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.31...quota-axi-v0.1.32) (2026-08-25)


### Features

* **providers:** delegate expired credential refresh to vendor CLIs ([#118](https://github.com/kunchenguid/quota-axi/issues/118)) ([3e29259](https://github.com/kunchenguid/quota-axi/commit/3e29259d41cadaa7547b3d4e93c8048b06d736d3))

## [0.1.31](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.30...quota-axi-v0.1.31) (2026-08-25)


### Features

* **cursor:** report Grok Bot weekly usage as its own scope ([#113](https://github.com/kunchenguid/quota-axi/issues/113)) ([600da6f](https://github.com/kunchenguid/quota-axi/commit/600da6fc08111a64efb35eeeaf76f1184b446b24))
* fetch Grok credits via Pi OAuth and fix Claude failure handling ([#116](https://github.com/kunchenguid/quota-axi/issues/116)) ([b371079](https://github.com/kunchenguid/quota-axi/commit/b371079fe5613f6773d51b34ea704aadb47e954f))


### Bug Fixes

* defer skill guidance to the live CLI ([#114](https://github.com/kunchenguid/quota-axi/issues/114)) ([5aa046d](https://github.com/kunchenguid/quota-axi/commit/5aa046d6fb6605fbed4753e5a9cbebec2ffa8136))

## [0.1.30](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.29...quota-axi-v0.1.30) (2026-08-21)


### Features

* **providers:** add Antigravity quota support ([#60](https://github.com/kunchenguid/quota-axi/issues/60)) ([9d7f942](https://github.com/kunchenguid/quota-axi/commit/9d7f942c73ddcf4cd795408ff9439f87f9a61274))
* **providers:** add Linux Cursor CLI credential source ([#2](https://github.com/kunchenguid/quota-axi/issues/2)) ([#98](https://github.com/kunchenguid/quota-axi/issues/98)) ([8c1d99e](https://github.com/kunchenguid/quota-axi/commit/8c1d99e52961384ac9b0ec499851a27bdb5c7401))


### Bug Fixes

* **cache:** scope Claude stale quota fallback to the current credential context ([#62](https://github.com/kunchenguid/quota-axi/issues/62)) ([edb9358](https://github.com/kunchenguid/quota-axi/commit/edb9358821e21ad03cba0312d5c342428ff0297f))

## [0.1.29](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.28...quota-axi-v0.1.29) (2026-08-18)


### Features

* **cli:** consolidate quota output for agent decisions ([#102](https://github.com/kunchenguid/quota-axi/issues/102)) ([e3e7939](https://github.com/kunchenguid/quota-axi/commit/e3e793995bedb855f42d754d0bdad7abd998759c))

## [0.1.28](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.27...quota-axi-v0.1.28) (2026-08-14)


### Bug Fixes

* **providers:** resolve Cursor monthly pace and runway ([#94](https://github.com/kunchenguid/quota-axi/issues/94)) ([ff89e7a](https://github.com/kunchenguid/quota-axi/commit/ff89e7a41fe1053781310fc842442182e7389f51))

## [0.1.27](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.26...quota-axi-v0.1.27) (2026-08-14)


### Features

* **cursor:** report effective remaining across quota windows ([#92](https://github.com/kunchenguid/quota-axi/issues/92)) ([649cede](https://github.com/kunchenguid/quota-axi/commit/649cede0bbad8bf44bbe52668a722b8976f4996d))

## [0.1.26](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.25...quota-axi-v0.1.26) (2026-08-13)


### Bug Fixes

* **providers:** prefer verifiably live credentials ([#90](https://github.com/kunchenguid/quota-axi/issues/90)) ([48892fc](https://github.com/kunchenguid/quota-axi/commit/48892fc92816c68f15b13039f5e886d213b7e091))

## [0.1.25](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.24...quota-axi-v0.1.25) (2026-08-13)


### Bug Fixes

* **cursor:** report CLI Keychain quota attempts and remedies ([#87](https://github.com/kunchenguid/quota-axi/issues/87)) ([bad10f1](https://github.com/kunchenguid/quota-axi/commit/bad10f12ad60b50021243e0ab103d016ff928e32))

## [0.1.24](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.23...quota-axi-v0.1.24) (2026-08-12)


### Bug Fixes

* **tui:** render unbounded providers as per-window cards ([#82](https://github.com/kunchenguid/quota-axi/issues/82)) ([7caff26](https://github.com/kunchenguid/quota-axi/commit/7caff26e9dfe86580a1d8d54371a2541c1d3076b))

## [0.1.23](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.22...quota-axi-v0.1.23) (2026-08-12)


### Features

* **cursor:** detect Cursor CLI Keychain auth ([#80](https://github.com/kunchenguid/quota-axi/issues/80)) ([6b7ff55](https://github.com/kunchenguid/quota-axi/commit/6b7ff55041b3b42529639a8ee6e4365822aa542f))

## [0.1.22](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.21...quota-axi-v0.1.22) (2026-08-12)


### Bug Fixes

* **tui:** align headline marker with binding window ([#78](https://github.com/kunchenguid/quota-axi/issues/78)) ([37a49dc](https://github.com/kunchenguid/quota-axi/commit/37a49dcf8a7d3f54e93787e0efdbcb8807e33e22))

## [0.1.21](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.20...quota-axi-v0.1.21) (2026-08-11)


### Features

* **tui:** label headline bars with binding windows ([#75](https://github.com/kunchenguid/quota-axi/issues/75)) ([de9d0c0](https://github.com/kunchenguid/quota-axi/commit/de9d0c00ef7757244ed419bd7ef3ae3d2fef0491))

## [0.1.20](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.19...quota-axi-v0.1.20) (2026-08-08)


### Bug Fixes

* **pace:** treat a missing resetsAt on a zero-use window as not-yet-triggered ([#70](https://github.com/kunchenguid/quota-axi/issues/70)) ([3ab4d12](https://github.com/kunchenguid/quota-axi/commit/3ab4d127c5adaa2768f5c2a1320cb14128ae1ad2))
* **tui:** polish --tui exhaustion notes and align two-up card rows ([#72](https://github.com/kunchenguid/quota-axi/issues/72)) ([170dd33](https://github.com/kunchenguid/quota-axi/commit/170dd33065168774ce39584a2e4110df3aa959cb))

## [0.1.19](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.18...quota-axi-v0.1.19) (2026-08-08)


### Features

* **tui:** make the human report live and act on captain feedback, fix Pi Kimi OAuth ([#68](https://github.com/kunchenguid/quota-axi/issues/68)) ([fcc9aa3](https://github.com/kunchenguid/quota-axi/commit/fcc9aa3b11dab333cbcb295bbdece303b730fd4e))

## [0.1.18](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.17...quota-axi-v0.1.18) (2026-08-07)


### Features

* **cli:** add human terminal quota report ([#66](https://github.com/kunchenguid/quota-axi/issues/66)) ([7c5bb5e](https://github.com/kunchenguid/quota-axi/commit/7c5bb5e538951973cc4de01a74f55cf0a9aa45a2))
* **models:** add intelligence-aware quota evidence ([#64](https://github.com/kunchenguid/quota-axi/issues/64)) ([229ad37](https://github.com/kunchenguid/quota-axi/commit/229ad37fd6ed368b08f76439c1db15959510a4f7))


### Bug Fixes

* **cli:** fast-path bare version checks ([#67](https://github.com/kunchenguid/quota-axi/issues/67)) ([f9d5b9f](https://github.com/kunchenguid/quota-axi/commit/f9d5b9f5fdd7d98817f29ef83935acd9b33093d4))

## [0.1.17](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.16...quota-axi-v0.1.17) (2026-07-31)


### Features

* report effective usable runway ([#57](https://github.com/kunchenguid/quota-axi/issues/57)) ([19d0403](https://github.com/kunchenguid/quota-axi/commit/19d04035e4adc2fa8c0ec280ba40d613de56bc22))

## [0.1.16](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.15...quota-axi-v0.1.16) (2026-07-28)


### Bug Fixes

* **providers:** correct Codex and Grok auth classification ([#51](https://github.com/kunchenguid/quota-axi/issues/51)) ([d4383e6](https://github.com/kunchenguid/quota-axi/commit/d4383e694472e6f689b26b636ba8a9cb15fef7f6))

## [0.1.15](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.14...quota-axi-v0.1.15) (2026-07-28)


### Features

* add cycle-average quota pace signals ([#49](https://github.com/kunchenguid/quota-axi/issues/49)) ([b465eae](https://github.com/kunchenguid/quota-axi/commit/b465eaeb4050e6ae919da7832908e33a9a9e7af8))


### Bug Fixes

* **providers:** distinguish expired Grok sessions from sign-in required ([#47](https://github.com/kunchenguid/quota-axi/issues/47)) ([83ef9fd](https://github.com/kunchenguid/quota-axi/commit/83ef9fd8b643790d71913c049f7554fd2e75abfc))

## [0.1.14](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.13...quota-axi-v0.1.14) (2026-07-27)


### Bug Fixes

* **claude:** pin Keychain reads to current user ([#46](https://github.com/kunchenguid/quota-axi/issues/46)) ([8f65d58](https://github.com/kunchenguid/quota-axi/commit/8f65d58aa0b0efacd0850b9107a8324b122654e3))
* **providers:** correct Claude auth and stale quota fallback ([#44](https://github.com/kunchenguid/quota-axi/issues/44)) ([8dd34ee](https://github.com/kunchenguid/quota-axi/commit/8dd34eee84da602844a8c2fac96fe71de158a514))

## [0.1.13](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.12...quota-axi-v0.1.13) (2026-07-25)


### Features

* report effective quota availability ([#41](https://github.com/kunchenguid/quota-axi/issues/41)) ([4760cfd](https://github.com/kunchenguid/quota-axi/commit/4760cfd820670ac42df487b1635b535eec236897))

## [0.1.12](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.11...quota-axi-v0.1.12) (2026-07-24)


### Bug Fixes

* **codex:** classify quota windows by exact duration ([1591c58](https://github.com/kunchenguid/quota-axi/commit/1591c585384fe69ac23e822d68f6b6662f6abe62))
* **codex:** derive window id/label/kind from actual window duration ([47db504](https://github.com/kunchenguid/quota-axi/commit/47db504dab7bf7f623b9e17728caaa0df4c55251))
* **codex:** identify quota windows by exact duration ([a24b1ff](https://github.com/kunchenguid/quota-axi/commit/a24b1ff246f7b958782da64fb75e07465bd5f28c))
* execute every PR body compliance event ([#37](https://github.com/kunchenguid/quota-axi/issues/37)) ([e85fdbc](https://github.com/kunchenguid/quota-axi/commit/e85fdbc0b100a1042f50935e467c0c301542e595))

## [0.1.11](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.10...quota-axi-v0.1.11) (2026-07-21)


### Bug Fixes

* **providers:** clean up unread Kimi responses ([#36](https://github.com/kunchenguid/quota-axi/issues/36)) ([b106f0f](https://github.com/kunchenguid/quota-axi/commit/b106f0f2e9f167e9adf2091be25b845b4d6d71b1))
* **providers:** keep Kimi credential inspection read-only ([#33](https://github.com/kunchenguid/quota-axi/issues/33)) ([17eadc9](https://github.com/kunchenguid/quota-axi/commit/17eadc9f3366fb6ba7f027481fbd8d14755220c8))
* **providers:** parse Pi Kimi credentials directly ([#35](https://github.com/kunchenguid/quota-axi/issues/35)) ([272a7bc](https://github.com/kunchenguid/quota-axi/commit/272a7bc1e6c5edce2f689e51e337762b46160b36))

## [0.1.10](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.9...quota-axi-v0.1.10) (2026-07-20)


### Features

* **providers:** add Kimi Code CLI quota fallback ([#31](https://github.com/kunchenguid/quota-axi/issues/31)) ([e21241f](https://github.com/kunchenguid/quota-axi/commit/e21241f43c2e5ccae051f6dce6e7c8901fa27046))

## [0.1.9](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.8...quota-axi-v0.1.9) (2026-07-20)


### Features

* **providers:** add Kimi Code quota reporting ([#29](https://github.com/kunchenguid/quota-axi/issues/29)) ([659a2eb](https://github.com/kunchenguid/quota-axi/commit/659a2eb4148418ada055bad831114e31cd6b1ff1))

## [0.1.8](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.7...quota-axi-v0.1.8) (2026-07-20)


### Bug Fixes

* **providers:** report authoritative Grok quota percentages ([#27](https://github.com/kunchenguid/quota-axi/issues/27)) ([17c4bd3](https://github.com/kunchenguid/quota-axi/commit/17c4bd38d258e63313586ac5bc1c0f9ce46fca36))

## [0.1.7](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.6...quota-axi-v0.1.7) (2026-07-18)


### Features

* **providers:** isolate managed Claude and Codex profiles ([#22](https://github.com/kunchenguid/quota-axi/issues/22)) ([b81d311](https://github.com/kunchenguid/quota-axi/commit/b81d3119c4f4a0a2ef5b577dd42963aa7da5f404))

## [0.1.6](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.5...quota-axi-v0.1.6) (2026-07-17)


### Features

* **cli:** migrate CLI plumbing to axi-sdk-js ([#20](https://github.com/kunchenguid/quota-axi/issues/20)) ([d59fc2a](https://github.com/kunchenguid/quota-axi/commit/d59fc2ab4e8c94fda2e38f0bbf7fecb72dc60a56))

## [0.1.5](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.4...quota-axi-v0.1.5) (2026-07-08)


### Bug Fixes

* **providers:** detect Grok OIDC auth records ([#11](https://github.com/kunchenguid/quota-axi/issues/11)) ([7b33cc6](https://github.com/kunchenguid/quota-axi/commit/7b33cc65abbfb923da9fa114a77da34ada9e6079))

## [0.1.4](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.3...quota-axi-v0.1.4) (2026-07-08)


### Features

* **providers:** add cursor copilot and grok quota reports ([#9](https://github.com/kunchenguid/quota-axi/issues/9)) ([1cf7fd5](https://github.com/kunchenguid/quota-axi/commit/1cf7fd5af7a376389f1943b12011e7d0c1200c55))

## [0.1.3](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.2...quota-axi-v0.1.3) (2026-07-08)


### Bug Fixes

* reuse granted Claude Keychain access on plain calls ([#7](https://github.com/kunchenguid/quota-axi/issues/7)) ([029f85f](https://github.com/kunchenguid/quota-axi/commit/029f85fa1c450eaccbc64302a9c723f512081f4b))

## [0.1.2](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.1...quota-axi-v0.1.2) (2026-07-07)


### Bug Fixes

* surface Claude Keychain access guidance ([#5](https://github.com/kunchenguid/quota-axi/issues/5)) ([6d25e11](https://github.com/kunchenguid/quota-axi/commit/6d25e11a3853fd55dab8a6e2668bb438c09c85e6))

## [0.1.1](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.0...quota-axi-v0.1.1) (2026-07-07)


### Features

* add release automation and public skill scaffolding ([#2](https://github.com/kunchenguid/quota-axi/issues/2)) ([10b3c46](https://github.com/kunchenguid/quota-axi/commit/10b3c46b2f0a3e1d8562b2a3e1d1dbfae09cb5da))

## Changelog
