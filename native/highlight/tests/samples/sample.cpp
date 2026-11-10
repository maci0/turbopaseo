#include <vector>
namespace demo {
template <typename T> class Stack { std::vector<T> items; public: void push(const T& v) { items.push_back(v); } };
}
auto lambda = [](int a) -> int { return a * 2; };
