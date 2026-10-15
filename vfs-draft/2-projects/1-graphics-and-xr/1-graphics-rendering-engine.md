# Graphics Rendering Engine

*Solo project, C++ and CUDA*

A Whitted-style ray tracer written from scratch in CUDA, with a desktop scene editor.

### What I built
* **GPU ray tracing:** took rendering from 5 s per frame on the CPU to a sustained 40 FPS at 1080p (about 200×) through GPU parallelization and variable-rate shading.
* **Foveated, variable-rate shading:** pixel groups (grid, radial, random or stripes) trace one ray per group and reconstruct the full frame, decoupling shading rate from pixel rate.
* **Shading pipeline:** ray-triangle intersection, shadow rays from multiple point lights, Lambertian diffuse with inverse-square falloff, recursive mirror reflection and Reinhard tone mapping.
* **Scene editor:** a C#/.NET Avalonia desktop app that calls the C++/CUDA core through P/Invoke, with OBJ model loading.
* **Cross-platform builds:** CMake for Linux, macOS and Windows across 6 CUDA architectures.

### Tech
* C++
* CUDA
* C#, .NET, Avalonia
* CMake

- [Source code](https://github.com/cnoble25/GraphicsRenderingEngine)
