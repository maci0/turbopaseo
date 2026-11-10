package demo;
import java.util.List;
@Deprecated
public final class Main {
  private static final int LIMIT = 42;
  public static void main(String[] args) { List<String> xs = List.of("a"); System.out.println(xs + " " + LIMIT); }
}
