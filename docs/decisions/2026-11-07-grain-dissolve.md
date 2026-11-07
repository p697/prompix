# The detail hero dissolves into the page as film grain

The owner wanted a more distinctive transition from the hero image into the page than a smooth fade. Four directions were mocked up on a real work: a tint taken from the image, a mirrored and blurred extension like Apple TV, a progressive blur, and a film-grain dissolve. The owner chose the film grain.

The grain dissolve suits the product's name, Darkroom White: the picture ends the way a print fades at its edge, not under a layer laid on top. The bottom 90 pt of the hero is masked with paper through a grain mask. The grain is densest mid-way and settles to plain paper at the edge. The mask is generated once in code, one grain per pixel at 3x across the widest phone, so there is no bundled asset and no per-frame cost. The page counter moves up to sit above the grain.

Rejected:
- Tinting the page from the image picks an unpredictable colour per work.
- The mirrored extension turns the page into a dark poster, which changes the whole detail design.
- A progressive blur is barely visible on dark edges.

Follow-up the same day:
- The owner found a frosted top and a grainy bottom an odd pair, so the hero's top edge now uses the same grain. It is the status bar plus 30 pt, starts at 90% paper and dissolves into the work. The frosted veil remains behind the collapsed title and on the home page.
- The bottom grain is 60 pt instead of 90 pt.
- On the device, a grey line flashed at the hero's bottom edge while the detail zoomed open. The hero's height is rarely a whole pixel, and the picture's last row showed through, so solid paper now runs 2 pt past the edge.

Second follow-up: short work. A 16:9 video lost most of its picture to the top and bottom grain. The owner proposed a half-screen minimum height with padding; padding would leave the work floating between empty bands, and the grain would still eat its edges. Instead the hero has two presentations. Portrait work (4:5 and taller) keeps the immersive grain. Square and landscape work sits whole below the top bar, like a print laid on the page, with no grain. Once it scrolls under the status bar, the frosted veil covers it.
