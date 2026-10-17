import XCTest
@testable import Prompix

final class ReadingScrollTests: XCTestCase {
    func testRestoredCompactStateSurvivesInitialGeometry() {
        var state = ReadingScrollState(collapsed: true)
        XCTAssertTrue(state.update(offset: 0, maximum: 1_000, isScrolling: false))
        XCTAssertTrue(state.update(offset: 250, maximum: 1_000, isScrolling: false))
        XCTAssertTrue(state.update(offset: 260, maximum: 1_000, isScrolling: false))
        XCTAssertFalse(state.update(offset: 220, maximum: 1_000, isScrolling: true))
    }

    func testDeliberateDirectionChangesAndTopReset() {
        var state = ReadingScrollState()
        XCTAssertFalse(state.update(offset: 0, maximum: 1000, isScrolling: false))
        XCTAssertTrue(state.update(offset: 200, maximum: 1000, isScrolling: true))
        XCTAssertTrue(state.update(offset: 192, maximum: 1000, isScrolling: true))
        XCTAssertFalse(state.update(offset: 170, maximum: 1000, isScrolling: true))
        XCTAssertFalse(state.update(offset: 175, maximum: 1000, isScrolling: true))
        XCTAssertTrue(state.update(offset: 220, maximum: 1000, isScrolling: true))
        XCTAssertFalse(state.update(offset: -40, maximum: 1000, isScrolling: true))
    }
    func testInertialSettlingCannotRevealControlsBeforeAUserReverses() {
        var state = ReadingScrollState()
        _ = state.update(offset: 0, maximum: 400, isScrolling: false)
        XCTAssertTrue(state.update(offset: 171, maximum: 400, isScrolling: true))
        XCTAssertTrue(state.update(offset: 201, maximum: 400, isScrolling: true, isInteracting: false))
        XCTAssertTrue(state.update(offset: 178, maximum: 400, isScrolling: true, isInteracting: false))
        XCTAssertTrue(state.update(offset: 178, maximum: 400, isScrolling: false, isInteracting: false))
        XCTAssertFalse(state.update(offset: 150, maximum: 400, isScrolling: true))
        XCTAssertFalse(state.update(offset: 0, maximum: 400, isScrolling: true, isInteracting: false))
    }

    func testBottomBounceAndLayoutChangesDoNotRevealChrome() {
        var state = ReadingScrollState()
        _ = state.update(offset: 0, maximum: 400, isScrolling: false)
        XCTAssertTrue(state.update(offset: 400, maximum: 400, isScrolling: true))
        XCTAssertTrue(state.update(offset: 470, maximum: 400, isScrolling: true))
        XCTAssertTrue(state.update(offset: 400, maximum: 400, isScrolling: true))
        XCTAssertTrue(state.update(offset: 300, maximum: 400, isScrolling: false))
        XCTAssertFalse(state.update(offset: 265, maximum: 400, isScrolling: true))
    }
}
