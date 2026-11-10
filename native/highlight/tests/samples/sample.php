<?php
namespace App;
class User { public function __construct(private string $name = "x") {} }
$u = new User("bob"); echo "Hello {$u->name}\n"; // done
?>
<p>after</p>
