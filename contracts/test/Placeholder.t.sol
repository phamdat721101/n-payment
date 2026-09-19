// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Placeholder} from "../src/Placeholder.sol";

contract PlaceholderTest is Test {
    function test_scaffoldVersion() public {
        Placeholder p = new Placeholder();
        assertEq(p.SCAFFOLD_VERSION(), 1);
    }
}
