# Third-party notices

Vaelen itself is MIT-licensed (see [LICENSE](LICENSE)). It has **no runtime npm dependencies**: the CLI uses only Node.js built-ins, and the window is a single HTML file.

The Windows executable does redistribute a runtime, so its licence travels with it.

## Redistributed in `VaelenGUI.exe`

The build copies the Node.js binary and injects the bundled GUI into it (Node SEA + postject), so the resulting executable contains:

- **Node.js** — MIT. Copyright Node.js contributors. Node itself bundles third-party code (V8, OpenSSL, ICU, zlib, and others) under their own permissive licences; the full text is at <https://github.com/nodejs/node/blob/main/LICENSE> and is included with every Node.js distribution.

The MIT text covering Node.js:

```
Copyright Node.js contributors. All rights reserved.

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
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Development-only dependencies

These are installed with `npm install` and are **not** part of the shipped executable or of any published artifact:

| Package | Licence | Use |
|---|---|---|
| `typescript` | Apache-2.0 | `tsc --noEmit` type checking |
| `@types/node` | MIT | Node.js type definitions |
| `esbuild` | MIT | bundling `src/gui/` into one CommonJS file |
| `postject` | MIT | injecting the SEA blob into the Node binary |

## Providers

Vaelen talks to whatever OpenAI-compatible endpoint you point it at (DeepSeek by default). That traffic, and the terms attached to it, are between you and the provider.
