# Support links per distribution channel

Decision for #62. The app stays free in every channel; what changes is whether it may *ask* for
money, and how. The rule comes from `supportPath()` in `@gjsify/distribution`
(gjsify ADR 0139), read at runtime, never from a build flag in this repo.

| Channel | `supportPath()` | App shows | Metainfo |
|---|---|---|---|
| Flathub, `.deb`, `.rpm`, AppImage | `external-link` | "Support" link in About, once-per-tax-year prompt after a filing | `<url type="donation">` |
| Microsoft Store | `none` | nothing | not shipped (the listing is written in Partner Center) |
| Mac App Store | `store-purchase` | nothing until a store provider exists | not shipped |

## Why

- **Apple, guideline 3.1.1:** tips only through in-app purchase; an external support link is a
  call to action the guideline restricts.
- **Microsoft:** the policy on voluntary donations (10.8.2) is checked in ADR 0139, but whether a
  link inside a free app passes certification is not confirmed. The channel stays `none` until
  Microsoft confirms it in writing.
- A tip in a store channel buys a thank-you and nothing else; no feature depends on it.

## Where it is enforced

- `app/src/frontends/desktop/main.ts`: the About dialog adds the "Support" link only for
  `external-link`.
- `app/src/core/config/support-prompt.ts`: `claimSupportPrompt` defaults `allowed` to
  `supportPath() === 'external-link'`, so the post-filing prompt never opens elsewhere.
- The metainfo file belongs to the Linux channels, which are all `external-link`.

A `store-purchase` row (a "Say thanks" button that starts an in-app purchase) waits for a store
provider in `@gjsify/store`; until then the App Store build shows no support UI at all.
