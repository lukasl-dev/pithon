# pithon

A persistent IPython kernel for [pi](https://github.com/earendil-works/pi).

The `ipython` tool keeps variables, imports, and output history between calls. Kernel state and a notebook are saved with the pi session.

## Nix

```nix
{
  inputs = {
    pi.url = "github:lukasl-dev/pi.nix";
    pithon.url = "github:lukasl-dev/pithon";
  };
}
```

```nix
{ inputs, pkgs, ... }:
let
  inherit (inputs.pithon.packages.${pkgs.system}) pithon;
in
{
  imports = [ inputs.pi.nixosModules.default ];

  programs.pi.coding-agent = {
    enable = true;
    extensions = [ "${pithon}" ];
  };
}
```

## Manual installation

```sh
git clone https://github.com/lukasl-dev/pithon \
  ~/.pi/agent/extensions/pi-ipython
```

On first use, pithon creates a small kernel environment with `uv`. Set `PI_IPYTHON_PYTHON` to use an existing Python with `ipykernel`, `jupyter_client`, `dill`, and `nest_asyncio` instead.

## Commands

- `/pithon` — settings
- `/kernel` — kernel status
- `/kernel restart` — restart the kernel
- `/kernel export [path]` — export the notebook

By default, pithon restores and snapshots the kernel namespace, exports a notebook at shutdown, and disables pi's built-in file and shell tools. Change these options with `/pithon`.
