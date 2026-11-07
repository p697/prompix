# The detail hero dissolves into the page as film grain

The owner wanted a more distinctive transition from the hero image into the page than a smooth fade. Four directions were mocked up on a real work: a tint taken from the image, a mirrored and blurred extension like Apple TV, a progressive blur, and a film-grain dissolve. The owner chose the film grain.

The grain dissolve suits the product's name, Darkroom White: the picture ends the way a print fades at its edge, not under a layer laid on top. The bottom 90 pt of the hero is masked with paper through a grain mask. The grain is densest mid-way and settles to plain paper at the edge. The mask is generated once in code, one grain per pixel at 3x across the widest phone, so there is no bundled asset and no per-frame cost. The page counter moves up to sit above the grain.

Rejected:
- Tinting the page from the image picks an unpredictable colour per work.
- The mirrored extension turns the page into a dark poster, which changes the whole detail design.
- A progressive blur is barely visible on dark edges.
