# pithon

A notebook-first coding extension for Pi.

The model receives one stateful `ipython` tool rather than Pi's separate
file-editing and shell tools. It operates through a persistent IPython kernel
for the current working directory, so it can retain named Python values,
imports, parsed files, helper functions, and intermediate results between tool
calls.

See [`ipython/README.md`](ipython/README.md) for the architecture, operating
model, safety boundaries, and test instructions. Run
[`scripts/install-test-extension`](scripts/install-test-extension) to replace
the global Pi test copy from this repository.
