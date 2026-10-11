#!/usr/bin/env python3
"""Generate original motion studies; these are not model-generated output."""
import math, subprocess
from pathlib import Path
from PIL import Image, ImageDraw
root = Path(__file__).resolve().parents[1]/'ios/Prompix/Resources'
w,h = 640,360
names=['slow-road','sea-breath','small-orbit','slow-bloom','coffee-pause','rain-window']
for number,name in enumerate(names):
    process=subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgb24','-video_size',f'{w}x{h}','-framerate','24','-i','-','-c:v','libx264','-crf','21','-pix_fmt','yuv420p','-movflags','+faststart',str(root/f'{name}.mp4')],stdin=subprocess.PIPE)
    for f in range(144):
        t=f/143
        image=Image.new('RGB',(w,h))
        draw=ImageDraw.Draw(image)
        cool=number in [1,5]
        a,b=((84,119,139),(201,216,209)) if cool else ((90,101,132),(244,179,122))
        for y in range(h):
            k=y/h
            draw.line([(0,y),(w,y)],fill=tuple(int(a[i]*(1-k)+b[i]*k) for i in range(3)))
        if number==0:
            sun_x=450+10*t
            draw.ellipse((sun_x-32,107,sun_x+32,171),fill=(255,225,166))
            ridge=[(x,220+24*math.sin(x/110)+12*math.sin(x/57)) for x in range(0,w+1,2)]
            draw.polygon(ridge+[(w,h),(0,h)],fill=(57,82,77))
            pts=[(320+math.sin(y/55+t*.08)*y*.30,218+y) for y in range(143)]
            for k in range(len(pts)-1): draw.line([pts[k],pts[k+1]],fill=(178,162,137),width=max(2,int(k*.22)))
        elif number==1:
            draw.rectangle((0,185,w,h),fill=(71,115,127))
            for k in range(18):
                y=193+k*10
                draw.line([(x,y+math.sin(x/65+t*5+k)*3) for x in range(0,w,3)],fill=(155,185,181),width=1)
        elif number==2:
            draw.rectangle((0,0,w,h),fill=(225,216,198))
            draw.ellipse((210,254,448,288),fill=(192,181,160))
            draw.rectangle((245,237,405,360),fill=(201,190,167))
            cx=320+12*math.sin(t*.52)
            draw.ellipse((cx-68,112,cx+68,248),fill=(116,131,108))
            draw.ellipse((cx-44,127,cx+21,193),fill=(142,153,130))
        elif number==3:
            draw.rectangle((0,0,w,h),fill=(223,226,211))
            draw.line((320,199,313,360),fill=(109,133,101),width=5)
            for k in range(10):
                angle=k*math.pi/5
                radius=32+t*6
                cx=320+math.cos(angle)*radius; cy=174+math.sin(angle)*radius
                draw.ellipse((cx-35,cy-39,cx+35,cy+39),fill=(239+k%3*4,228+k%3*3,213+k%3*4))
            draw.ellipse((302,156,338,192),fill=(200,167,95))
        elif number==4:
            draw.rectangle((0,0,w,h),fill=(216,200,174))
            draw.ellipse((204,242,430,276),fill=(179,155,125))
            draw.ellipse((384,165,440,227),outline=(233,225,208),width=12)
            draw.rounded_rectangle((235,153,397,250),radius=28,fill=(240,234,217))
            draw.ellipse((235,140,397,182),fill=(229,218,194))
            draw.ellipse((246,149,386,175),fill=(78,59,43))
            for k in range(3):
                points=[(286+k*22+math.sin(y/20+t*4+k)*7,145-y) for y in range(15,95)]
                draw.line(points,fill=(234,224,204),width=2)
        else:
            draw.rectangle((0,0,w,h),fill=(114,141,139))
            for k in range(34):
                x=(k*83)%w; y=((k*47)+t*30)%h
                draw.ellipse((x-2,y-5,x+3,y+5),fill=(179,197,192))
                draw.line((x,y,x-1,y+13),fill=(155,178,173),width=1)
            draw.rectangle((90,0,98,h),fill=(76,99,99))
        # A slow push-in demonstrates steady camera movement without model claims.
        margin=int(t*10)
        if margin: image=image.crop((margin,margin,w-margin,h-margin)).resize((w,h),Image.Resampling.LANCZOS)
        if f==0:
            import json
            folder=root/'Assets.xcassets'/f'{name}.imageset'
            folder.mkdir(exist_ok=True)
            image.save(folder/f'{name}.png')
            (folder/'Contents.json').write_text(json.dumps({'images':[{'filename':f'{name}.png','idiom':'universal'}],'info':{'author':'xcode','version':1}}))
        process.stdin.write(image.tobytes())
    process.stdin.close()
    if process.wait()!=0: raise SystemExit('ffmpeg failed')
print('Wrote six original motion studies')
