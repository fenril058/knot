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
        nodejs = pkgs.nodejs_26;
        playwrightBrowsers = pkgs.playwright-driver.browsers.override {
          withFirefox = false;
          withWebkit = true;
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

          # Volta は管理下の CLI に NODE_PATH を注入するが、linkNodeModulesHook は
          # NODE_PATH 全体をリンク先ディレクトリとして扱うため、実行前に除去する。
          preShellHook = ''
            unset NODE_PATH
          '';

          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          # Nix provides browser runtime libraries through patched RPATHs, which the
          # npm Playwright host-package validator cannot discover.
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
          PLAYWRIGHT_BROWSERS_PATH = "${playwrightBrowsers}";
        };

        devShells.workflow = pkgs.mkShell {
          packages = with pkgs; [
            actionlint
            ghalint
            pinact
            zizmor
          ];
        };
      }
    );
}
