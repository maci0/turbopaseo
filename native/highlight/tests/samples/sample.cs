using System;
namespace Demo {
  public class Program {
    [Obsolete]
    static async Task Main(string[] args) { var name = $"Hi {args.Length}"; Console.WriteLine(@"verbatim\n" + name); }
  }
}
