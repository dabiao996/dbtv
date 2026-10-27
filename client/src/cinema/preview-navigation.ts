type PreviewClick={button:number;defaultPrevented:boolean;ctrlKey:boolean;metaKey:boolean;shiftKey:boolean;altKey:boolean;fromControl:boolean;hasSelection:boolean};

// Background clicks supplement real cover/title links, never override another control.
export function shouldOpenPreviewDetails(click:PreviewClick){
  return click.button===0&&!click.defaultPrevented&&!click.ctrlKey&&!click.metaKey&&!click.shiftKey&&!click.altKey&&!click.fromControl&&!click.hasSelection;
}
