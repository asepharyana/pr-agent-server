{
  description = "PR-Agent Server — GitHub App webhook server (Nix build)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        python = pkgs.python312;
      in {
        packages.default = pkgs.stdenv.mkDerivation {
          pname = "pr-agent-server";
          version = "1.0.0";
          src = ./.;

          nativeBuildInputs = [ python pkgs.git pkgs.cacert ];

          buildPhase = ''
            export HOME=$TMPDIR/home
            mkdir -p "$HOME"
            export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
            export NODE_EXTRA_CA_CERTS=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt

            echo "=== Creating venv ==="
            python -m venv $out/venv
            $out/venv/bin/pip install --no-cache-dir --upgrade pip 2>&1

            echo "=== pip install deps ==="
            $out/venv/bin/pip install --no-cache-dir \
              pr-agent fastapi uvicorn httpx pyjwt 2>&1
            echo "=== Build complete ==="
          '';

          installPhase = ''
            mkdir -p $out/bin $out/lib/pr-agent-server
            cp run_server.py $out/lib/pr-agent-server/

            cat > $out/bin/pr-agent-server << WRAPPER
#!${pkgs.runtimeShell}
export PATH=${pkgs.git}/bin:\$PATH
cd $out/lib/pr-agent-server
exec $out/venv/bin/python run_server.py
WRAPPER
            chmod +x $out/bin/pr-agent-server
          '';
        };
      });
}
