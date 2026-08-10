{
  description = "Persistent IPython kernel for pi";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs =
    inputs@{ self, flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      perSystem =
        { pkgs, ... }:
        {
          packages = rec {
            default = pithon;
            pithon = pkgs.callPackage ./package.nix {
              version = self.rev or self.dirtyRev or "unknown";
            };
          };

          formatter = pkgs.nixfmt;
        };
    };
}
