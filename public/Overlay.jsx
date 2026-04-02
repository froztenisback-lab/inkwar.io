import React from 'react';

export default function Overlay({bg,icon,title,sub,btnColor,onBack}){
  return(
    <div className={`fixed inset-0 w-full h-full ${bg} backdrop-blur-md flex items-center justify-center p-4 z-[300]`} style="
    position: fixed;
">
      <div className="text-center">{icon}
        <h2 className="text-4xl font-black text-white mb-2">{title}</h2>
        <p className="text-white/70 mb-6 font-medium">{sub}</p>
        <button onClick={onBack} className={`${btnColor} font-bold py-2.5 px-8 rounded-full shadow-lg hover:scale-105 transition-transform`}>Back to Menu</button>
      </div>
    </div>
  );
}