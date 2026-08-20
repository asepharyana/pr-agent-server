{
  description = "PR-Agent Server — GitHub App webhook server (Nix build)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" ] (system:
      let
        pkgs = import nixpkgs { inherit system; };
        python = pkgs.python312;
      in {
        packages.default = pkgs.stdenv.mkDerivation {
          pname = "pr-agent-server";
          version = "1.0.0";
          src = ./.;

          nativeBuildInputs = [ python pkgs.git pkgs.cacert ];
          buildInputs = [ pkgs.stdenv.cc.cc.lib ];

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

            # Copy server modules
            cp src/run_server.py $out/lib/pr-agent-server/
            cp src/sync-key.py $out/lib/pr-agent-server/
            cp src/health-check.py $out/lib/pr-agent-server/
            cp src/trivial_merge.py $out/lib/pr-agent-server/
            cp src/auto_merge_bot.py $out/lib/pr-agent-server/
            cp src/callback_server.py $out/lib/pr-agent-server/

            # Wrapper: pr-agent-server (main FastAPI webhook server)
            cat > $out/bin/pr-agent-server << WRAPPER
#!${pkgs.runtimeShell}
export PATH=${pkgs.git}/bin:$PATH
export LD_LIBRARY_PATH=${pkgs.stdenv.cc.cc.lib}/lib:$LD_LIBRARY_PATH
cd $out/lib/pr-agent-server
exec $out/venv/bin/python run_server.py
WRAPPER
            chmod +x $out/bin/pr-agent-server

            # Wrapper: pr-agent-sync-key (BWS key sync)
            cat > $out/bin/pr-agent-sync-key << WRAPPER2
#!${pkgs.runtimeShell}
export LD_LIBRARY_PATH=${pkgs.stdenv.cc.cc.lib}/lib:$LD_LIBRARY_PATH
exec $out/venv/bin/python $out/lib/pr-agent-server/sync-key.py
WRAPPER2
            chmod +x $out/bin/pr-agent-sync-key

            # Wrapper: pr-agent-health-check (model health watchdog)
            cat > $out/bin/pr-agent-health-check << WRAPPER3
#!${pkgs.runtimeShell}
export LD_LIBRARY_PATH=${pkgs.stdenv.cc.cc.lib}/lib:$LD_LIBRARY_PATH
exec $out/venv/bin/python $out/lib/pr-agent-server/health-check.py
WRAPPER3
            chmod +x $out/bin/pr-agent-health-check

            # Wrapper: pr-agent-auto-merge (merge worker)
            cat > $out/bin/pr-agent-auto-merge << WRAPPER4
#!${pkgs.runtimeShell}
export PATH=${pkgs.git}/bin:$PATH
export LD_LIBRARY_PATH=${pkgs.stdenv.cc.cc.lib}/lib:$LD_LIBRARY_PATH
cd $out/lib/pr-agent-server
exec $out/venv/bin/python auto_merge_bot.py
WRAPPER4
            chmod +x $out/bin/pr-agent-auto-merge
          '';
        };
      });
}
