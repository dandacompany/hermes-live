import React from 'react';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@hermes/plugin-sdk';
export const hint:React.CSSProperties={fontSize:'.75rem',color:'var(--dt-muted-foreground)',lineHeight:1.5,margin:0};
export const section:React.CSSProperties={display:'grid',gap:12};
export const divider='1px solid var(--ui-stroke-secondary)';
export function FieldSelect({label,value,options,onChange,disabled=false}:{label:string;value:string;options:{value:string;label:string}[];onChange:(value:string)=>void;disabled?:boolean}){
 return <div style={{display:'grid',gap:6,minWidth:0}}>
  <span style={hint}>{label}</span>
  <Select value={value} onValueChange={onChange} disabled={disabled}>
   <SelectTrigger aria-label={label} style={{width:'100%',minWidth:0,fontSize:'.8125rem'}}><span style={{overflow:'hidden',textOverflow:'ellipsis'}}><SelectValue/></span></SelectTrigger>
   <SelectContent>{options.map(option=><SelectItem key={option.value} value={option.value} style={{whiteSpace:'normal'}}>{option.label}</SelectItem>)}</SelectContent>
  </Select>
 </div>;
}
