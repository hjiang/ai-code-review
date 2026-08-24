{
  description = "AI Code Review GitHub Action - dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        # Keep the dev Node version in sync with `runs.using: node24` in action.yml
        node = pkgs.nodejs_24;
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            node
            pkgs.nixfmt
          ];
          shellHook = ''
            export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
            if [ -f package.json ] && [ ! -d node_modules ]; then
              echo "Installing npm dev dependencies (first enter)..."
              npm install
            fi
          '';
        };
      }
    );
}
