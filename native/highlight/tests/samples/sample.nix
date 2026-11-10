{ pkgs ? import <nixpkgs> {} }:
let
  name = "demo";
  version = "1.0";
in pkgs.stdenv.mkDerivation {
  pname = name;
  inherit version;
  src = ./.;
  buildPhase = ''
    echo ${name}
  '';
}
