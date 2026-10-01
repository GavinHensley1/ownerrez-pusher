# cam/ — metal CAM generator

Offline toolpath generation for the Rambo buckle in C752 nickel silver.

This exists because a machinability audit on 2026-09-30 simulated all 833,989
feed moves of the five certified Kiri:Moto programs and concluded they cannot be
cut in C752 as written: 20.266 h of programmed feed, a Rough stage that cut air
85.3% of the time and removed 7.8% of the relief, a Finish stage that was doing
the roughing by accident, a Profile stage of 74 full-immersion slot passes at a
1.25 µm/tooth chip load, and a Release stage with no tabs at all.

**Nothing here talks to the machine.** It reads a geometry model, writes `.nc`
files, and validates them. Installing a program for cutting is a separate,
operator-approved step through the hosted Project UI.

## The diagnosed root cause, and how this layer answers it

The router is a manual AC Genmitsu GM7100E whose gear 4 is around 18,000 rpm.
With a 6.35 mm cutter that is roughly 360 m/min in nickel silver, about ten
times too fast. The old CAM compensated by driving axial depth and feed down
until the chip load fell below the carbide edge radius, so the tool ploughed and
burnished instead of cutting — which work-hardens C752, which makes it harder to
cut. The ten hours was that spiral, not the material.

So:

- `machine-library.mjs` — the router has **six** gears from 6,500 rpm, not just
  18,000. Intermediate detents are modelled from two sources and carry an rpm
  *range*; every safety check uses the worst end of it.
- `material-library.mjs` — C752 surface-speed ceilings and chip-load bands,
  including the `PLOUGHING_CHIP_LOAD_MM` floor.
- `tool-library.mjs` — only tools the operator physically has. Retired tools
  (the MC40A that snapped, the RU2100 the operator rejected) throw if selected.
- `feeds-speeds.mjs` — **the only place a cutting feed can come from.** Picks the
  lowest gear that still reaches a sensible feed, then rejects the stage if the
  resulting chip load could plough or the surface speed could exceed the limit.
  Also rejects a feed the controller cannot physically stream, because a feed
  the machine cannot deliver silently halves the real chip load.

## Layout

| file | role |
|---|---|
| `machine-library.mjs` | machine + router gears, clearance plane, measured line rate |
| `material-library.mjs` | C752 surface speeds and chip-load bands |
| `tool-library.mjs` | physical tools, geometry, engagement and sweep profiles |
| `feeds-speeds.mjs` | feed/speed solver, gear selection, rejection gates |
| `relief-model.mjs` | height-field model, tool sweep, silhouette, polygon helpers |
| `morphology.mjs` | disc erosion/dilation — what a flat cutter can actually reach |
| `program.mjs` | G-code builder enforcing the motion contract; clearance assertion |
| `stages.mjs` | Rough / Finish / Profile / Release generators |
| `validate.mjs` | independent re-read of emitted text; immersion and tab checks |
| `fidelity.mjs` | proves the output still cuts the design |
| `build-relief-model.mjs` | one-time: reconstruct geometry from the certified programs |
| `generate-buckle.mjs` | the job; writes `.nc` files plus a manifest |

## Where the geometry comes from

The original relief was modelled in Kiri:Moto from an STL this project no longer
holds. What it does hold is the certified Finish program, whose preview the
operator visually accepted as reproducing the complete design. Sweeping that
program's tool over a 0.1 mm grid reconstructs exactly that surface — stronger
than re-deriving a relief from the source PNG, because it cannot drift from the
approved artwork, and it is automatically limited to what the W01015 can
physically resolve.

Its reconstructed volume, 2,734 mm³, independently matches the audit's
2,774 mm³ figure.

## Usage

```sh
# once, with the certified .nc files available (not in this repo)
node cam/build-relief-model.mjs <certified-dir>

# generate; placement is a parameter
node cam/generate-buckle.mjs <out-dir> [--offset-x=0] [--offset-y=0] [--no-fidelity]

node --test cam/test-cam.mjs
```

## Known limits

- **Per-gear rpm is modelled, not measured.** Only 6,500–30,000 across six
  detents is manufacturer-stated. A reading of the dial's printed table would
  tighten it; the fail-safe ranges mean it cannot invalidate the output.
- **A 4.99 mm clearance plane cannot survive a probe-plate family mix-up.** The
  documented plate variants differ by about 6 mm, so the manifest reports
  `physicalSurfaceProofRequired: true`. Numbers cannot settle that; touching the
  surface can.
- **Fidelity is measured against the reconstruction, not the original STL.**
- Placement on the current blank is unresolved: that blank has damage inside the
  present footprint.
