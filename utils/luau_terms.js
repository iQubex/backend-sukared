const LUA_KEYWORDS = new Set([
    'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
    'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
    'true', 'until', 'while', 'continue', 'export', 'type'
]);

const LUA_GLOBALS = new Set([
    '_G', '_VERSION', 'assert', 'collectgarbage', 'error', 'getfenv', 'getmetatable',
    'ipairs', 'loadstring', 'newproxy', 'next', 'pairs', 'pcall', 'print', 'rawequal',
    'rawget', 'rawlen', 'rawset', 'select', 'setfenv', 'setmetatable', 'tonumber',
    'tostring', 'type', 'unpack', 'xpcall'
]);

const LUAU_GLOBALS = new Set([
    'typeof', 'gcinfo', 'elapsedTime', 'tick', 'time', 'DateTime', 'Random',
    'Vector2', 'Vector2int16', 'Vector3', 'Vector3int16', 'CFrame', 'Color3',
    'ColorSequence', 'ColorSequenceKeypoint', 'NumberRange', 'NumberSequence',
    'NumberSequenceKeypoint', 'BrickColor', 'UDim', 'UDim2', 'Ray', 'Rect',
    'Region3', 'Region3int16', 'Axes', 'Faces', 'Enum', 'Instance'
]);

const ROBLOX_GLOBALS = new Set([
    'game', 'workspace', 'script', 'shared', 'plugin', 'owner', 'settings',
    'UserSettings', 'version', 'Spawn', 'Delay', 'Wait', 'DebuggerManager',
    'Stats', 'PathfindingService', 'DebuggerConnection'
]);

const LIBRARIES = new Set([
    'coroutine', 'task', 'string', 'table', 'math', 'bit32', 'buffer', 'os',
    'utf8', 'debug'
]);

const KNOWN_GLOBALS = new Set([
    ...LUA_GLOBALS,
    ...LUAU_GLOBALS,
    ...ROBLOX_GLOBALS,
    ...LIBRARIES
]);

const isKnownLuauGlobal = (name) => KNOWN_GLOBALS.has(name);

module.exports = {
    LUA_KEYWORDS,
    LUA_GLOBALS,
    LUAU_GLOBALS,
    ROBLOX_GLOBALS,
    LIBRARIES,
    KNOWN_GLOBALS,
    isKnownLuauGlobal
};
