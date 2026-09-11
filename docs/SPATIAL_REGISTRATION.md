# Spatial registration

Where the measured neurons are, where the body is, and exactly how confident we
are about the relationship between them.

**The governing rule: measured Fish1 coordinates are immutable.** Nothing in
this application rewrites a published position. Everything else is an explicit,
invertible, provenance-carrying transform applied on top, which is why the
inspector can always show both the citable source coordinate and wherever it is
currently being drawn.

---

## 1. The voxel size correction

Phase 1 used 16 × 16 × 30 nm, taken from the release prose. **That is wrong for
the released data, and the brain was being rendered at twice its true size in x
and y.** Three independent lines of evidence:

| Evidence | Result |
|---|---|
| **Volume bounds.** The published volume is 280000 × 65000 × 8689 voxels at 8 nm, 140000 × 32500 × 8689 at 16 nm ([`clahe_231218/info`](https://storage.googleapis.com/fish1-public/clahe_231218/info)). The released CAVE somas export reaches **y = 49,799**. | Impossible on a 32,500-voxel axis. Fits the 8 nm grid. |
| **Soma density.** At 8 nm the 30,346 soma occupy 163.7 × 275.4 × 120.9 µm → mean spacing **5.6 µm**. At 16 nm → 9.0 µm. | 5.6 µm is a larval neuron diameter. 9.0 µm is too sparse for packed tissue. |
| **Official notebook.** Its coordinate-lookup helper defaults to `resolution=(8, 8, 30)`. | Agrees with 8 nm. |

We follow the data. The value lives in exactly one place
(`FISH1_VOXEL_SPACE`), and `pipeline/fish1/validate.py` now rejects any export
whose coordinates fall outside the published volume, or whose soma spacing is
outside 3–14 µm — so this class of error cannot ship again.

---

## 2. Coordinate spaces

| Space | Units | Meaning |
|---|---|---|
| `fish1-source` | voxel | Published Fish1 coordinates. **Citable. Never rewritten.** |
| `fish1-physical` | µm | Source × voxel size. Distances are meaningful here. |
| `atlas` | µm | Reserved for a real atlas frame. **Not populated.** |
| `body-rest` | µm | The reference body, undeformed. +X anterior, +Y dorsal, +Z left. |
| `body-pose` | µm | After rig deformation. A per-frame visual transform. |
| `world` | mm | The simulated tank. |
| `view` | — | Camera clip space. |

---

## 3. Fish1 axis interpretation — DERIVED, not documented

The release does not state what its axes mean anatomically. We derived it, and
record the evidence next to each axis so a reader can disagree:

| Axis | Extent | Interpretation | Confidence | Evidence |
|---|---:|---|---|---|
| x | 2240 µm | +x posterior | moderate | Longest axis, consistent with "brain and anterior spinal cord". Sign from the released subset's positive soma-density skew along +x (dense brain → sparse cord). |
| y | 520 µm | mediolateral | assumed | Matches larval head width. **Which side is left is arbitrary** and nothing scientific depends on it. |
| z | 261 µm | +z dorsal | moderate | Thinnest axis, matches larval brain depth, and is the 30 nm serial-section axis. |

Because this is derived rather than documented, **the brain viewer still shows
no anterior/dorsal labels on raw Fish1 coordinates.** Camera presets are named
by axis (`+X`, `-Z`, …). This interpretation exists only to place a reference
body, and everything downstream of it is labelled approximate.

---

## 4. The registration itself

`fish1-physical → body-rest` is a **rigid** transform:

```
fish +x (posterior)    -> body -x   (body +x is anterior)
fish +y (mediolateral) -> body +z
fish +z (dorsal)       -> body +y
```

plus a translation placing the population centroid at the brain anchor
(`BRAIN_ANCHOR_UM`), chosen so the released region sits inside the **rigid head
bone** — brain tissue is never deformed by the swimming rig.

Two properties are enforced and tested:

- **Determinant +1.** An axis permutation with one sign flip; handedness is
  preserved, so the animal is not mirrored.
- **No scaling.** Both spaces are micrometres describing a 7 dpf larva. Scaling
  would distort every measured distance to make the picture tidier. A test
  asserts inter-neuron distances survive the transform unchanged.

### Status: APPROXIMATE

| | |
|---|---|
| Method | `manual-approximate` |
| Provenance | `derived` |
| Error estimate | **not quantified** (`null`, not a made-up number) |
| Landmarks fitted | none |
| Atlas used | none |

The UI says this in the anatomy panel, every time. It is a presentation
alignment so the body and the neurons share a frame — **it is not an anatomical
registration.**

### What would make it real

1. Register the Fish1 volume to a shared atlas frame via FishExplorer
   (<https://fishexplorer.zib.de/>), which documents mapping Fish1
   reconstructions into mapZebrain space.
2. Obtain the resulting transform, add it as an `atlas-registration` step
   (`fish1-physical → atlas`), and derive `atlas → body-rest` from atlas
   landmarks instead of the volume aspect ratio.
3. Report a real `errorEstimateUm` from the residuals.

The `SpatialTransform` type already carries `method`, `provenance` and
`errorEstimateUm`, so this is adding a step to a chain, not a rewrite.

---

## 5. Composition and the weakest-link rule

`composeChain()` multiplies a sequence of transforms and reports the **weakest**
provenance across it. An exact unit conversion followed by an approximate
alignment yields an approximate result, and the UI must say so. Chains are
validated for continuity (`a.target === b.source`) and are always invertible, so
any drawn position maps back to its exact source voxel — tested to 2 decimal
places on a real-scale coordinate.

---

## 6. Pose: how neurons move without being moved

When the organism swims:

```
measured position (immutable)
      ↓ registration          (fish1-source → body-rest)
body rest position
      ↓ rig pose              (body-rest → body-pose)   visual only
      ↓ world placement       (body-pose  → world)
      ↓ render transform
drawn pixel
```

The renderer takes a single `somaModel` matrix and applies it to every soma at
draw time. The uploaded buffer — the measured data — is never rewritten. That is
what lets 30,346 real neurons ride inside a swimming body while remaining, in
every sense that matters, exactly where Fish1 said they were.

Rig pose carries provenance `simulated` and the caveat that it changes where a
neuron is **drawn**, never what was measured.
