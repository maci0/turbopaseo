package main

import "fmt"

type Point struct{ X, Y int }

func (p *Point) Add(o Point) Point { return Point{p.X + o.X, p.Y + o.Y} }

func main() {
	ch := make(chan int, 3)
	go func() { ch <- 1 }()
	fmt.Println(<-ch, `raw`, 'r', 0x1F)
}
