// Probes a function with expando members (one named `static`) merged with a
// type-only namespace, the shape express.ts exports.
class Thing {
  constructor(readonly label: string) {}
}
function make(): Thing {
  return new Thing("made");
}
namespace make {
  export type Label = string;
}
function staticHelper(root: string): string {
  return `static:${root}`;
}
make.json = (): string => "json";
make.static = staticHelper;

const label: make.Label = make().label;
console.log("merged", label, make.json(), make.static("/srv"));
