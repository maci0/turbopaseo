import 'package:flutter/material.dart';
// comment
@immutable
class Counter extends StatelessWidget {
  final int count = 0x1F;
  String label(String name) => 'Hi $name and ${count + 1}';
  /* nested /* comment */ end */
  Future<void> run() async { await Future.delayed(Duration(seconds: 1)); }
}
