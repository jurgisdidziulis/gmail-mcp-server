import {deflateSync} from 'node:zlib';
import {createCanvas} from '@napi-rs/canvas';
export function scan(pageCount=1,widthPoints=500){
 const width=1000,height=160,canvas=createCanvas(width,height),ctx=canvas.getContext('2d');
 ctx.fillStyle='white';ctx.fillRect(0,0,width,height);ctx.fillStyle='black';ctx.font='bold 48px sans-serif';ctx.fillText('OFFICE INVOICE 12345',30,95);
 const rgba=ctx.getImageData(0,0,width,height).data,rgb=Buffer.alloc(width*height*3);
 for(let i=0,j=0;i<rgba.length;i+=4){rgb[j++]=rgba[i];rgb[j++]=rgba[i+1];rgb[j++]=rgba[i+2];}
 const image=deflateSync(rgb),content=Buffer.from('q 500 0 0 80 0 0 cm /Im0 Do Q');
 const stream=(prefix,bytes)=>Buffer.concat([Buffer.from(prefix+` /Length ${bytes.length} >>\nstream\n`),bytes,Buffer.from('\nendstream')]);
 const imageId=3+pageCount,contentId=imageId+1;
 const objects=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from(`<< /Type /Pages /Kids [${Array.from({length:pageCount},(_,i)=>`${3+i} 0 R`).join(' ')}] /Count ${pageCount} >>`),...Array.from({length:pageCount},()=>Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPoints} 80] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`)),stream(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,image),stream('<<',content)];
 const chunks=[Buffer.from('%PDF-1.7\n')],offsets=[0];let length=chunks[0].length;
 objects.forEach((obj,i)=>{offsets.push(length);const part=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),obj,Buffer.from('\nendobj\n')]);chunks.push(part);length+=part.length;});
 chunks.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
 return Buffer.concat(chunks);
}
