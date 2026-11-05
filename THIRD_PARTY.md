# Dependencies and references

The application and test utilities in this repository are original MIT code. No application code was imported from another print-farm project or private repository. Dependencies retain their own licenses; the root MIT license does not replace them.

| Component                                   | Use                          | License reported by package/project |
| ------------------------------------------- | ---------------------------- | ----------------------------------- |
| Nuxt, Vue, Vue Router                       | App runtime                  | MIT                                 |
| Zod                                         | Protocol validation          | MIT                                 |
| Effect                                      | Typed simulator I/O failures | MIT                                 |
| TypeScript                                  | Development                  | Apache-2.0                          |
| Bun type definitions, Node type definitions | Development                  | MIT                                 |
| Playwright                                  | Browser tests                | Apache-2.0                          |
| Prettier                                    | Formatting                   | MIT                                 |
| virtual-klipper-printer                     | Separate test container      | GPL-3.0                             |
| Spoolman                                    | Separate inventory simulator | MIT                                 |

Exact package versions and integrity values are in `bun.lock`. The simulator image is digest-pinned in Compose. Its software stays inside the external container; no upstream source/configuration is vendored. Follow upstream licensing if redistributing that image. Runtime Docker bases also retain their upstream notices.

## Pinned Spoolman provenance

Read-only registry and source review on 2026-11-04 verified the Compose reference `ghcr.io/donkie/spoolman@sha256:1405c3db0661cabf45209701f95304cf65f7db3b0f262dc824d32a1694fdf5fa`. The GHCR manifest and configuration blob were fetched with anonymous pull access and their SHA-256 hashes checked. No image layers were downloaded or upstream code executed.

| Artifact              | Verified metadata                                                         |
| --------------------- | ------------------------------------------------------------------------- |
| Pinned manifest       | OCI image manifest, linux/amd64                                           |
| Configuration blob    | `sha256:13edd8c5c34ed240a200bb88314cc78df6c6c3955aa5546c12df93a6140fd792` |
| Version label         | `0.27.1`                                                                  |
| Source revision label | `ff8efd517b76a4b2783f29c89e9b9fbcd8cd167b`                                |
| License label         | MIT                                                                       |

The [LICENSE at that exact revision](https://github.com/Donkie/Spoolman/blob/ff8efd517b76a4b2783f29c89e9b9fbcd8cd167b/LICENSE) is MIT and identifies **Copyright (c) 2023 Daniel Hultgren**. Copies or substantial portions must retain its copyright and permission notices. The root project license does not replace them; preserve the complete upstream license when redistributing covered material.

The [Dockerfile at that revision](https://github.com/Donkie/Spoolman/blob/ff8efd517b76a4b2783f29c89e9b9fbcd8cd167b/Dockerfile) also includes a Python/Debian base, dependencies and built frontend assets. The MIT label does not describe every bundled component's license. Their complete inventory and notice inclusion inside the pinned image were not audited. Registry source labels are not signed build attestations; this review does not prove the image was built from the labeled source or independently reproduce its build. Review those obligations before redistributing the image. This repository references the external simulator without vendoring its implementation.

## Password hashing dependency review

On 2026-11-04, reviewed the installed `@adonisjs/hash@9.1.1` package and its complete resolved `dependencies` closure against exact versions in `bun.lock`. Package metadata and the shipped license text agree for each entry below. Every inspected package contains its license file. This is a local package/license review, not a registry signature, source-to-package reproducibility or vulnerability audit.

| Resolved package                 | License      | Shipped notice file |
| -------------------------------- | ------------ | ------------------- |
| `@adonisjs/hash@9.1.1`           | MIT          | `LICENSE.md`        |
| `@phc/format@1.0.0`              | MIT          | `license`           |
| `@poppinss/utils@6.10.1`         | MIT          | `LICENSE.md`        |
| `@poppinss/exception@1.2.3`      | MIT          | `LICENSE.md`        |
| `@poppinss/object-builder@1.1.0` | MIT          | `LICENSE.md`        |
| `@poppinss/string@1.7.2`         | MIT          | `LICENSE.md`        |
| `@types/pluralize@0.0.33`        | MIT          | `LICENSE`           |
| `case-anything@3.1.7`            | MIT          | `LICENSE`           |
| `pluralize@8.0.0`                | MIT          | `LICENSE`           |
| `slugify@1.6.9`                  | MIT          | `LICENSE`           |
| `flattie@1.1.1`                  | MIT          | `license`           |
| `safe-stable-stringify@2.5.0`    | MIT          | `LICENSE`           |
| `secure-json-parse@4.1.1`        | BSD-3-Clause | `LICENSE`           |

The closure contains twelve MIT packages and one BSD-3-Clause package. `@types/pluralize` is included because its parent declares it as a dependency, even though it supplies types. The optional peers `argon2` and `bcrypt` are not resolved in this lockfile and are not part of this review; enabling another hash driver requires a new dependency review. The configured scrypt implementation uses Node's crypto API.

These licenses permit use alongside this MIT project while retaining their own conditions. BSD-3-Clause additionally requires its notice, conditions and disclaimer in binary distribution materials and prohibits endorsement using the copyright holders' names without permission. Preserve the complete notices below with distributions containing these packages, including bundled copies. This document must accompany runtime distributions if the bundler omits upstream license files; its presence in the source repository alone does not establish that a container includes it. The application Dockerfile explicitly copies this document and the project LICENSE into the runtime image. Other distribution formats must also retain these notices.

The following texts are copied only from the installed packages' license files; no implementation is copied. Identical full texts are grouped without altering their content.

<details>
<summary>@adonisjs/hash@9.1.1</summary>

```text
# The MIT License

Copyright (c) 2023 Harminder Virk

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the 'Software'), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

</details>

<details>
<summary>@phc/format@1.0.0</summary>

```text
MIT License

Copyright (c) 2018-2020 Simone Primarosa

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

</details>

<details>
<summary>@poppinss/utils@6.10.1</summary>

```text
# The MIT License

Copyright 2021 Harminder Virk, contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the 'Software'), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

</details>

<details>
<summary>@poppinss/exception@1.2.3, @poppinss/object-builder@1.1.0, @poppinss/string@1.7.2</summary>

```text
# The MIT License

Copyright (c) 2023

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the 'Software'), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

</details>

<details>
<summary>@types/pluralize@0.0.33</summary>

```text
MIT License

    Copyright (c) Microsoft Corporation.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE
```

</details>

<details>
<summary>case-anything@3.1.7</summary>

```text
MIT License

Copyright (c) 2019 Luca Ban - Mesqueeb

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

</details>

<details>
<summary>pluralize@8.0.0</summary>

```text
The MIT License (MIT)

Copyright (c) 2013 Blake Embrey (hello@blakeembrey.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

</details>

<details>
<summary>slugify@1.6.9</summary>

```text
The MIT License (MIT)

Copyright (c) Simeon Velichkov <simeonvelichkov@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

</details>

<details>
<summary>flattie@1.1.1</summary>

```text
The MIT License (MIT)

Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

</details>

<details>
<summary>safe-stable-stringify@2.5.0</summary>

```text
The MIT License (MIT)

Copyright (c) Ruben Bridgewater

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

</details>

<details>
<summary>secure-json-parse@4.1.1</summary>

```text
Copyright (c) 2019, Sideway Inc, and project contributors
Copyright (c) 2019-present The Fastify team <https://github.com/fastify/fastify#team>
All rights reserved.

The complete list of contributors can be found at:
- https://github.com/hapijs/bourne/graphs/contributors
- https://github.com/fastify/secure-json-parse/graphs/contributors

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

</details>

## Requested development references

Reviewed metadata and entry points on 2026-11-04. No skill installer, hook or third-party skill script was run. A skill's availability does not authorize external chats, subagents, credential access or deployment.

| Reference                                                                                                | Use in this milestone                                                                                 |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Ponytail](https://github.com/dietrichgebert/ponytail)                                                   | Small complete changes, boundary validation and explicit limitations                                  |
| [Stop Slop](https://github.com/hardikpandya/stop-slop)                                                   | Direct documentation and pt-BR copy                                                                   |
| [No AI Slop](https://github.com/petergyang/no-ai-slop), [Humanizer](https://github.com/blader/humanizer) | Editorial references reviewed; no files imported                                                      |
| [Unslop](https://github.com/heydamir/unslop)                                                             | UI guidance reviewed; no copied assets or skill text (CC BY 4.0)                                      |
| [Visant](https://github.com/pedrojaques99/visant-skills-public)                                          | Frontend/preflight entry points reviewed; broader design workflow reserved for actual product screens |
| [Cloudflare security audit](https://github.com/cloudflare/security-audit-skill)                          | Workflow reviewed; no complete audit claimed or external probing performed                            |
| [Unlazy](https://github.com/Leonxlnx/unlazy)                                                             | Completion discipline reviewed; checker/hooks not installed or executed                               |
| [Caveman](https://github.com/JuliusBrussee/caveman)                                                      | Concision guidance reviewed; no orchestrator used                                                     |
| [pstack](https://github.com/backnotprop/pstack)                                                          | Catalog reviewed; multi-agent and external tooling not used                                           |
| [Goldie](https://github.com/software-mansion-labs/goldie)                                                | App-store asset tooling; outside this web-app skeleton's scope                                        |
| [Effect](https://github.com/Effect-TS/effect)                                                            | Installed as a pinned dependency and exercised in simulator probe tests                               |

AGPL, BSL and FSL application sources are not copied into this MIT project. Future reuse requires inspecting the exact source revision and retaining all applicable notices.

## Postgres.js 3.4.9

The application and isolated database harnesses use `postgres` version `3.4.9`, authored by Rasmus Porsager, under the **Unlicense**. It is not MIT-licensed; its permissive terms allow its use alongside this MIT project. The exact [registry package](https://registry.npmjs.org/postgres/3.4.9) and [upstream manifest](https://github.com/porsager/postgres/blob/v3.4.9/package.json) declare no runtime dependencies.

On 2026-11-04 the registry tarball was fetched without executing package scripts and its SHA-512 verified against the registry integrity value recorded in `bun.lock`. The tarball omits the standalone license file. The complete [license at the pinned upstream tag](https://github.com/porsager/postgres/blob/v3.4.9/UNLICENSE) is retained below; preserve it when redistributing the dependency. This review does not claim an exhaustive advisory or source audit.

```text
This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <https://unlicense.org/>
```

## Connector bundled protocol validation

The Connector bundle includes the existing pinned `zod@4.6.7` dependency through its pairing-proof validation. Its installed package declares MIT; the complete notice below was read from that exact installed package. The Connector build copies this document and the project LICENSE into `dist/`, and copies the upstream notice byte-for-byte to `dist/ZOD-LICENSE`. Distribute those files alongside `cli.js`; a standalone copy of the bundle is incomplete distribution material. No new dependency was added for this integration.

```text
MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## jose 6.2.15

The farm server uses `jose@6.2.15` for JWT signing and verification. The npm package declares MIT and no runtime dependencies. Node 24.20.0 synthetic signing and verification was checked locally; this is not an exhaustive security audit. Retain the complete notice below with distributions containing the dependency. The farm build copies this document into its output.

```text
The MIT License (MIT)

Copyright (c) 2018 Filip Skokan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```
