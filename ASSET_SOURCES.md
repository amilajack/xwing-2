# Reviewed Sketchfab sources

The import script accepts only the exact creator, model ID, download state, and
CC Attribution license reviewed below. It downloads Sketchfab's converted glTF,
packs each source into a local GLB, losslessly deduplicates and joins compatible
ship primitives to reduce draw calls, removes animations unused by the game,
validates the high-detail file, and derives the lowest-preset ship LOD with
meshoptimizer. The asteroid pack deliberately keeps separate source meshes so
the runtime can instance one detailed rock rather than repeating whole clusters.
Medium, High, Ultra, and Custom keep the full source geometry. High-detail
textures are capped at 2K and encoded as quality-92 WebP; the Lowest-only LOD
uses 1K quality-84 textures.

| Game role | Sketchfab model | Creator | Source triangles | License |
| --- | --- | --- | ---: | --- |
| Player X-wing | [X-Wing](https://sketchfab.com/3d-models/x-wing-a185c8bb6e9d43e4b597b856b176d768) | chris_warstat | 218,649 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| TIE fighter | [Tie Fighter](https://sketchfab.com/3d-models/tie-fighter-722a39247ee84ed892bdc01e22bfbc36) | Cristianolop | 175,787 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| TIE interceptor | [Emperor's Royal Guard TIE Interceptor](https://sketchfab.com/3d-models/star-wars-tie-interceptor-emperors-royal-guard-47222ad5bcff43fe868b65a06009e870) | DanielAndersson | 117,177 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Stealth bomber | [B-2 Spirit](https://sketchfab.com/3d-models/b-2-spirit-9f7e360e2c074db1b9ccabd5dc4b8302) | hilosrun | 61,699 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Asteroid field | [Asteroids Pack (rocky version)](https://sketchfab.com/3d-models/asteroids-pack-rocky-version-adde1ecf129e4509be8af61b84bafa85) | SebastianSosnowski | 23,076 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |

Sketchfab requires an account API token even for freely downloadable models.
Keep the token outside the repository and import the reviewed assets with:

```bash
SKETCHFAB_API_TOKEN=your_token npm run assets:sketchfab
```

After a successful import, `public/models/sketchfab-attribution.json` records
the exact live metadata used for attribution and provenance.
