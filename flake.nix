{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        inherit (pkgs) importNpmLock;
        nodejs = pkgs.nodejs_24;
        playwrightBrowsers = pkgs.playwright-driver.browsers.override {
          withFirefox = false;
          withWebkit = false;
        };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            jdk
            just
            zizmor
            actionlint
            typescript-language-server
            biome
            npm-check-updates
            nodejs
            importNpmLock.hooks.linkNodeModulesHook
          ];

          npmDeps = importNpmLock.buildNodeModules {
            npmRoot = ./.;
            inherit nodejs;
          };

          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          PLAYWRIGHT_BROWSERS_PATH = "${playwrightBrowsers}";
        };

        devShells.workflow = pkgs.mkShell {
          packages = with pkgs; [
            actionlint
            ghalint
            zizmor
          ];
        };
      }
    );
}
