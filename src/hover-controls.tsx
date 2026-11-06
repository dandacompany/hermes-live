import React,{useEffect,useRef,useState,type ReactElement,type ReactNode} from 'react';
import {Popover,PopoverContent,PopoverTrigger,Tip} from '@hermes/plugin-sdk';

/** SDK portal keeps the controls outside the composer's clipped surface. */
export function HoverControls({primary,children,label,tip,holdOpen}:{primary:ReactElement;children:ReactNode;label:string;tip:string;holdOpen:boolean}){
 const [open,setOpen]=useState(false);const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const panel=useRef<HTMLDivElement>(null);
 const anchor=useRef<HTMLSpanElement>(null),skipFocus=useRef(false);
 const cancel=()=>{if(timer.current!==null)clearTimeout(timer.current);timer.current=null};
 const show=()=>{cancel();setOpen(true)};
 const hideSoon=()=>{cancel();timer.current=setTimeout(()=>{timer.current=null;setOpen(false)},150)};
 useEffect(()=>cancel,[]);
 useEffect(()=>{
  if(!open||holdOpen)return;
  const move=(event:PointerEvent)=>{
   const node=event.target instanceof Node?event.target:null;
   if(node&&(anchor.current?.contains(node)||panel.current?.contains(node)))cancel();
   else if(timer.current===null)hideSoon();
  };
  document.addEventListener('pointermove',move,true);
  return()=>document.removeEventListener('pointermove',move,true);
 },[open,holdOpen]);
 const escape=()=>{cancel();setOpen(false);skipFocus.current=true;anchor.current?.querySelector('button')?.focus();skipFocus.current=false};
 return <Popover open={open||holdOpen} onOpenChange={(value:boolean)=>{if(value)show();else setOpen(false)}}>
  <span ref={anchor} style={{display:'inline-flex',position:'relative'}} onPointerEnter={show} onPointerLeave={hideSoon} onFocus={()=>{if(!skipFocus.current)show()}} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))hideSoon()}} onKeyDown={e=>{
   if(e.key==='Escape'&&!holdOpen){e.stopPropagation();escape()}
   else if(!holdOpen&&((e.key==='Tab'&&!e.shiftKey)||e.key==='ArrowUp'||e.key==='ArrowDown')){
    e.preventDefault();show();requestAnimationFrame(()=>panel.current?.querySelector('button')?.focus());
   }
  }}>
   <Tip label={tip} placement="control"><PopoverTrigger asChild>{primary}</PopoverTrigger></Tip>
  </span>
  <PopoverContent ref={panel} role="group" aria-label={label} side="top" align="center" sideOffset={4} variant="menu" onPointerEnter={show} onPointerLeave={hideSoon} onFocus={show} onBlur={(e:React.FocusEvent<HTMLElement>)=>{if(!e.currentTarget.contains(e.relatedTarget))hideSoon()}} onOpenAutoFocus={(e:Event)=>e.preventDefault()} onCloseAutoFocus={(e:Event)=>e.preventDefault()} onEscapeKeyDown={()=>{if(!holdOpen)escape()}} style={{width:'auto',minWidth:0,padding:0,border:0,background:'transparent',boxShadow:'none',backdropFilter:'none',display:'flex',flexDirection:'column-reverse',alignItems:'center',gap:4}}>
   {children}
  </PopoverContent>
 </Popover>;
}
