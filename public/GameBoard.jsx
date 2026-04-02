import { socket } from './main';

const handleAction = (actionData) => {
  if (mode === 'online') {
    // Tell the server what happened
    socket.emit('game_action', actionData);
  } else {
    // Run local Bot logic instead
    runBotLogic(actionData);
  }
  
  // Update your local screen immediately
  applyActionToLocalState(actionData);
};