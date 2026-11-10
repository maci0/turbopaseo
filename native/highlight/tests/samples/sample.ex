defmodule Greeter do
  @moduledoc "Greets"
  def hello(name) when is_binary(name), do: "Hello, #{name}"
  defp private(:atom, %{key: value}), do: [value | []]
end
