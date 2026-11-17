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
        # e2e を動かすのに要る分だけの shell。CI の e2e job はこれを使う。
        # 開発用ツールが cache.nixos.org に無いと、CI ではソースからのビルドになり、時間制限を超えることがある。
        e2eShell = {
          packages = [
            nodejs
            importNpmLock.hooks.linkNodeModulesHook
          ]
          # WebKit/WPE needs an EGL vendor even on GPU-less CI runners.
          ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.mesa.llvmpipeHook ];

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
      in
      {
        devShells.default = pkgs.mkShell (
          e2eShell
          // {
            packages =
              (with pkgs; [
                jdk
                just
                zizmor
                actionlint
                typescript-language-server
                biome
                npm-check-updates
              ])
              ++ e2eShell.packages;
          }
        );

        devShells.e2e = pkgs.mkShell e2eShell;

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
