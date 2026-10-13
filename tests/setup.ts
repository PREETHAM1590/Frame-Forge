// A busy machine (a build or antivirus scan running beside the tests) can make a render take longer than the 1 s default wait.
import { configure } from "@testing-library/dom";
configure({ asyncUtilTimeout: 5000 });
