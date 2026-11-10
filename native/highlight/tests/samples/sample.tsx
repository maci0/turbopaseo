export function Hello({ name }: { name: string }) {
  return <div className="greeting">Hello, {name}! {1 + 2}</div>;
}
