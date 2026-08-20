{
  lib,
  stdenvNoCC,
  nodejs,
  python3,
  version,
}:

let
  kernelPython = python3.withPackages (python: [
    python.dill
    python.ipykernel
    python.jupyter-client
    python.nest-asyncio
    python.pillow
  ]);
in
stdenvNoCC.mkDerivation {
  pname = "pithon";
  inherit version;

  src = lib.cleanSource ./.;

  nativeCheckInputs = [ nodejs ];
  doCheck = true;

  checkPhase = ''
    runHook preCheck

    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"

    ${kernelPython}/bin/python -m py_compile sidecar.py

    PI_IPYTHON_PYTHON=${kernelPython}/bin/python \
      ${kernelPython}/bin/python tests/sidecar-integration.py

    PI_IPYTHON_PYTHON=${kernelPython}/bin/python \
      node --experimental-transform-types --disable-warning=ExperimentalWarning \
      tests/kernel-client-integration.ts

    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out
    cp \
      index.ts \
      kernel-client.ts \
      kernel-runtime.ts \
      sidecar.py \
      config.ts \
      settings.ts \
      README.md \
      LICENSE \
      $out/
    printf '%s\n' '${kernelPython}/bin/python' > $out/kernel-python.txt

    runHook postInstall
  '';

  meta = {
    description = "Persistent IPython kernel extension for pi";
    homepage = "https://github.com/lukasl-dev/pithon";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
